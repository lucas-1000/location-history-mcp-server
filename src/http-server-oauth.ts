#!/usr/bin/env node

/**
 * OAuth 2.1-enabled HTTP server for location-history-mcp-server
 *
 * This server provides location history access through the Model Context Protocol (MCP)
 * with OAuth 2.1 authentication for ChatGPT Deep Research integration.
 *
 * Architecture:
 * - Validates Bearer tokens with health-data-storage backend
 * - Uses AsyncLocalStorage for per-request session isolation
 * - Direct PostgreSQL database access for location data
 * - Implements RFC 9728 for OAuth discovery
 * - Supports iOS app uploads with Bearer token auth
 *
 * OAuth Flow:
 * 1. Client discovers OAuth via /.well-known/oauth-protected-resource
 * 2. Client initiates OAuth at backend authorization server
 * 3. Client connects to /sse with Bearer token in Authorization header
 * 4. Server validates token and creates isolated session
 * 5. All tool calls execute within session context
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  Tool,
} from '@modelcontextprotocol/sdk/types.js';
import express from 'express';
import dotenv from 'dotenv';
import { AsyncLocalStorage } from 'async_hooks';
import { v4 as uuidv4 } from 'uuid';
import axios from 'axios';
import { Database } from './database.js';
import { PlacesAnalyzer } from './places-analyzer.js';
import { GooglePlacesClient } from './google-places.js';
import { LocationUploadPayload } from './types.js';

dotenv.config();

// Configuration
const PORT = process.env.PORT || 8000;
const HOST = process.env.HOST || '0.0.0.0';
const DB_CONNECTION_STRING =
  process.env.DATABASE_URL || 'postgresql://user:pass@localhost:5432/health_data';
const GOOGLE_PLACES_API_KEY = process.env.GOOGLE_PLACES_API_KEY || '';
const BACKEND_URL =
  process.env.BACKEND_URL || 'https://health-data-storage-835031330028.us-central1.run.app';
const OAUTH_CLIENT_ID = process.env.OAUTH_CLIENT_ID;
const OAUTH_CLIENT_SECRET = process.env.OAUTH_CLIENT_SECRET;
const PUBLIC_URL = process.env.PUBLIC_URL || `http://localhost:${PORT}`;

// Validate OAuth configuration
if (!OAUTH_CLIENT_ID || !OAUTH_CLIENT_SECRET) {
  console.error('❌ Missing required OAuth environment variables:');
  console.error('   OAUTH_CLIENT_ID and OAUTH_CLIENT_SECRET must be set');
  process.exit(1);
}

console.log('🔧 Configuration:');
console.log(`   Backend URL: ${BACKEND_URL}`);
console.log(`   Public URL:  ${PUBLIC_URL}`);
console.log(`   OAuth Client: ${OAUTH_CLIENT_ID}`);
console.log(`   Database:    ${DB_CONNECTION_STRING.split('@')[1] || 'local'}`);

// Initialize services
const database = new Database(DB_CONNECTION_STRING);
const placesAnalyzer = new PlacesAnalyzer(database);
const googlePlaces = GOOGLE_PLACES_API_KEY ? new GooglePlacesClient(GOOGLE_PLACES_API_KEY) : null;

// Initialize database schema
await database.initialize();
console.log('✅ Database initialized');

// Session management using AsyncLocalStorage
// This provides per-request session isolation for multi-user support
const sessionContext = new AsyncLocalStorage<string>();
const sessionUsers = new Map<string, number>(); // sessionId -> userId
const sessionTokens = new Map<string, string>(); // sessionId -> accessToken

/**
 * Get the current user ID from session context
 */
function getCurrentUserId(): number | undefined {
  const sessionId = sessionContext.getStore();
  if (!sessionId) {
    console.warn('⚠️  No session ID in context');
    return undefined;
  }
  const userId = sessionUsers.get(sessionId);
  if (!userId) {
    console.warn(`⚠️  No user ID found for session: ${sessionId}`);
  }
  return userId;
}

// ============================================================================
// MCP SERVER SETUP (Shared Instance)
// ============================================================================

/**
 * Create ONE MCP server instance (reused for all sessions)
 * This is critical for proper message routing via the transport Map
 */
const mcpServer = new Server(
  { name: 'location-history-mcp-server', version: '1.0.0' },
  { capabilities: { tools: {} } }
);

// Setup tool handlers ONCE for the shared server
setupToolHandlers(mcpServer);

/**
 * Validate OAuth access token with backend and return user ID
 */
async function getUserIdFromToken(accessToken: string): Promise<number> {
  try {
    const response = await axios.get(`${BACKEND_URL}/api/user/me`, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    });

    if (!response.data || !response.data.id) {
      throw new Error('Invalid token response from backend');
    }

    return response.data.id;
  } catch (error) {
    if (axios.isAxiosError(error)) {
      throw new Error(
        `Token validation failed: ${error.response?.status} ${error.response?.statusText}`
      );
    }
    throw error;
  }
}

// Express app for HTTP endpoints
const app = express();

// Middleware - parse JSON except for /message endpoint
app.use((req, res, next) => {
  if (req.path === '/message') {
    next();
  } else {
    express.json()(req, res, next);
  }
});

// RFC 9728: OAuth 2.0 Protected Resource Metadata
// This enables automatic OAuth discovery by ChatGPT Deep Research
app.get('/.well-known/oauth-protected-resource', (_req, res) => {
  const baseUrl = PUBLIC_URL;

  res.json({
    resource: baseUrl,
    authorization_servers: [BACKEND_URL],
    bearer_methods_supported: ['header'],
    resource_signing_alg_values_supported: [],
    resource_documentation: `${baseUrl}/docs`,
    resource_policy_uri: `${baseUrl}/policy`,
    mcp_endpoint: `${baseUrl}/sse`,
  });
});

// ============================================================================
// CLAUDE OAUTH ROUTING WORKAROUND
// ============================================================================
// Problem: When Claude is configured with URL https://server/sse, it appends
// /sse to the OAuth discovery URLs, resulting in requests to:
//   - /.well-known/oauth-protected-resource/sse (404)
//   - /.well-known/oauth-authorization-server/sse (404)
// Solution: Add route handlers with /sse suffix that serve the same OAuth metadata

/**
 * RFC 9728 Protected Resource Metadata - Workaround for Claude routing
 * Serves the same response as the main endpoint but with /sse suffix
 */
app.get('/.well-known/oauth-protected-resource/sse', (_req, res) => {
  const baseUrl = PUBLIC_URL;

  res.json({
    resource: baseUrl,
    authorization_servers: [BACKEND_URL],
    bearer_methods_supported: ['header'],
    resource_signing_alg_values_supported: [],
    resource_documentation: `${baseUrl}/docs`,
    resource_policy_uri: `${baseUrl}/policy`,
    mcp_endpoint: `${baseUrl}/sse`,
  });
});

/**
 * Authorization Server Metadata - Workaround for Claude routing
 * Proxies to the authorization server's metadata endpoint
 */
app.get('/.well-known/oauth-authorization-server/sse', async (_req, res) => {
  const authServerUrl = BACKEND_URL;

  try {
    // Fetch and proxy the authorization server metadata
    const response = await fetch(`${authServerUrl}/.well-known/oauth-authorization-server`);
    const metadata = await response.json();
    return res.json(metadata);
  } catch (error) {
    console.error('❌ Failed to fetch authorization server metadata:', error);
    return res.status(502).json({ error: 'Failed to fetch authorization server metadata' });
  }
});

console.log('✅ Claude OAuth routing workaround enabled');
console.log('   Routes added: /.well-known/oauth-protected-resource/sse');
console.log('   Routes added: /.well-known/oauth-authorization-server/sse');

// Health check endpoint
app.get('/health', (_req, res) => {
  res.json({
    status: 'healthy',
    service: 'location-history-mcp-server',
    version: '1.0.0',
    oauth_enabled: true,
    timestamp: new Date().toISOString(),
  });
});

// OAuth authorization redirect endpoint
app.get('/oauth/authorize', (req, res) => {
  const state = req.query.state || uuidv4();
  const redirectUri = `${PUBLIC_URL}/oauth/callback`;

  const authUrl = new URL(`${BACKEND_URL}/oauth/authorize`);
  authUrl.searchParams.set('client_id', OAUTH_CLIENT_ID);
  authUrl.searchParams.set('redirect_uri', redirectUri);
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('state', state as string);
  authUrl.searchParams.set('scope', 'location:read location:write');

  console.log(`🔐 Redirecting to authorization: ${authUrl.toString()}`);
  return res.redirect(authUrl.toString());
});

// OAuth callback endpoint
app.get('/oauth/callback', async (req, res) => {
  const { code, state: _state, error } = req.query;

  if (error) {
    console.error(`❌ OAuth error: ${error}`);
    return res.status(400).json({ error: error as string });
  }

  if (!code) {
    return res.status(400).json({ error: 'Missing authorization code' });
  }

  try {
    console.log('🔄 Exchanging authorization code for access token...');

    const tokenResponse = await axios.post(
      `${BACKEND_URL}/oauth/token`,
      {
        grant_type: 'authorization_code',
        code: code as string,
        redirect_uri: `${PUBLIC_URL}/oauth/callback`,
        client_id: OAUTH_CLIENT_ID,
        client_secret: OAUTH_CLIENT_SECRET,
      },
      {
        headers: { 'Content-Type': 'application/json' },
      }
    );

    const { access_token, refresh_token, expires_in } = tokenResponse.data;

    console.log('✅ OAuth token exchange successful');

    return res.json({
      success: true,
      access_token,
      refresh_token,
      expires_in,
      token_type: 'Bearer',
      message: 'Authorization successful. Use this access token in the Authorization header.',
    });
  } catch (error) {
    console.error('❌ Token exchange failed:', error);
    return res.status(500).json({
      error: 'token_exchange_failed',
      error_description: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

// Define MCP tools
const tools: Tool[] = [
  {
    name: 'search',
    description:
      'Search through your location history, places, and visits. ' +
      'Query can include date ranges, place names, or natural language. Returns searchable results with IDs.',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description:
            'Search query for location data. Can include keywords like "last week", "yesterday", ' +
            '"Home", "Work", specific places, or time periods.',
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'fetch',
    description:
      'Retrieve complete details for a specific location item by ID. ' +
      'Use this after finding items with the search tool.',
    inputSchema: {
      type: 'object',
      properties: {
        id: {
          type: 'string',
          description:
            'The unique identifier for the location item. Format: type:id ' +
            '(e.g., "place:123", "visit:456", "location:2024-01-15T10:30:00Z")',
        },
      },
      required: ['id'],
    },
  },
  {
    name: 'get_current_location',
    description: 'Get your most recent location',
    inputSchema: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
  {
    name: 'get_location_history',
    description:
      'Get your location history for a specific date range. Returns GPS coordinates with timestamps.',
    inputSchema: {
      type: 'object',
      properties: {
        start_date: {
          type: 'string',
          description: 'Start date in ISO format (e.g., 2025-01-01T00:00:00Z)',
        },
        end_date: {
          type: 'string',
          description: 'End date in ISO format (e.g., 2025-01-31T23:59:59Z)',
        },
        limit: {
          type: 'number',
          description: 'Maximum number of points to return (default: 1000)',
        },
      },
      required: ['start_date', 'end_date'],
    },
  },
  {
    name: 'get_location_at_time',
    description: 'Find where you were at a specific time (finds closest match within 10 minutes)',
    inputSchema: {
      type: 'object',
      properties: {
        timestamp: {
          type: 'string',
          description: 'ISO timestamp (e.g., 2025-01-15T14:30:00Z)',
        },
      },
      required: ['timestamp'],
    },
  },
  {
    name: 'search_locations_near',
    description:
      'Find all times you were near specific coordinates or address. Useful for "when was I at this restaurant?"',
    inputSchema: {
      type: 'object',
      properties: {
        latitude: {
          type: 'number',
          description: 'Latitude of the location',
        },
        longitude: {
          type: 'number',
          description: 'Longitude of the location',
        },
        radius_meters: {
          type: 'number',
          description: 'Search radius in meters (default: 100)',
        },
        start_date: {
          type: 'string',
          description: 'Optional: Start date to filter results',
        },
        end_date: {
          type: 'string',
          description: 'Optional: End date to filter results',
        },
      },
      required: ['latitude', 'longitude'],
    },
  },
  {
    name: 'get_frequent_places',
    description: 'Get your most frequently visited places, ordered by visit count',
    inputSchema: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
  {
    name: 'get_travel_stats',
    description:
      'Get travel statistics for a date range including distance traveled, average speed, etc.',
    inputSchema: {
      type: 'object',
      properties: {
        start_date: {
          type: 'string',
          description: 'Start date in ISO format',
        },
        end_date: {
          type: 'string',
          description: 'End date in ISO format',
        },
      },
      required: ['start_date', 'end_date'],
    },
  },
  {
    name: 'list_all_places',
    description:
      'List all identified places (both labeled and unlabeled). Shows visit counts and coordinates.',
    inputSchema: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
  {
    name: 'label_place',
    description: 'Give a name and category to a place (e.g., "Home", "Work", "Equinox Gym")',
    inputSchema: {
      type: 'object',
      properties: {
        place_id: {
          type: 'number',
          description: 'ID of the place to label',
        },
        name: {
          type: 'string',
          description: 'Name for the place (e.g., "Home", "Work", "Whole Foods")',
        },
        category: {
          type: 'string',
          description: 'Optional category: home, work, gym, restaurant, store, etc.',
        },
      },
      required: ['place_id', 'name'],
    },
  },
  {
    name: 'get_place_visits',
    description: 'Get all visits to a specific place or all places within a date range',
    inputSchema: {
      type: 'object',
      properties: {
        place_id: {
          type: 'number',
          description: 'Optional: Filter by specific place ID',
        },
        place_name: {
          type: 'string',
          description: 'Optional: Filter by place name (e.g., "Work", "Home")',
        },
        start_date: {
          type: 'string',
          description: 'Optional: Start date filter',
        },
        end_date: {
          type: 'string',
          description: 'Optional: End date filter',
        },
      },
      required: [],
    },
  },
  {
    name: 'get_time_at_place',
    description: 'Calculate total time spent at a place (by name or ID) within a date range',
    inputSchema: {
      type: 'object',
      properties: {
        place_id: {
          type: 'number',
          description: 'Place ID',
        },
        place_name: {
          type: 'string',
          description: 'Place name (alternative to place_id)',
        },
        start_date: {
          type: 'string',
          description: 'Start date in ISO format',
        },
        end_date: {
          type: 'string',
          description: 'End date in ISO format',
        },
      },
      required: ['start_date', 'end_date'],
    },
  },
  {
    name: 'enrich_place_with_google',
    description: 'Use Google Places API to get business name and details for a place',
    inputSchema: {
      type: 'object',
      properties: {
        place_id: {
          type: 'number',
          description: 'Place ID to enrich',
        },
      },
      required: ['place_id'],
    },
  },
  {
    name: 'get_unlabeled_frequent_places',
    description:
      "Find frequently visited places that haven't been labeled yet. Suggests places you should name.",
    inputSchema: {
      type: 'object',
      properties: {
        min_visits: {
          type: 'number',
          description: 'Minimum visit count to suggest (default: 3)',
        },
      },
      required: [],
    },
  },
  {
    name: 'process_recent_locations',
    description: 'Trigger place detection and clustering for recent unprocessed location data',
    inputSchema: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
];

// Helper function to parse date queries
function parseDateQuery(query: string): { start?: Date; end?: Date } {
  const now = new Date();
  const lowerQuery = query.toLowerCase();

  if (lowerQuery.includes('today')) {
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    return { start: today, end: now };
  }

  if (lowerQuery.includes('yesterday')) {
    const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    const yesterdayStart = new Date(
      yesterday.getFullYear(),
      yesterday.getMonth(),
      yesterday.getDate()
    );
    const yesterdayEnd = new Date(yesterdayStart.getTime() + 24 * 60 * 60 * 1000);
    return { start: yesterdayStart, end: yesterdayEnd };
  }

  const lastDaysMatch = lowerQuery.match(/last (\d+) days?/);
  if (lastDaysMatch) {
    const days = parseInt(lastDaysMatch[1]);
    return { start: new Date(now.getTime() - days * 24 * 60 * 60 * 1000), end: now };
  }

  const lastWeekMatch = lowerQuery.match(/last week/);
  if (lastWeekMatch) {
    return { start: new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000), end: now };
  }

  // Default to last 7 days
  return { start: new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000), end: now };
}

/**
 * Setup tool handlers for MCP server
 * All handlers use getCurrentUserId() to get the authenticated user
 */
function setupToolHandlers(server: Server) {
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return { tools };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    console.log(`🔧 Tool called: ${name}`, JSON.stringify(args));

    const userId = getCurrentUserId();
    if (!userId) {
      throw new Error('No authenticated user in session');
    }

    // Convert userId (number) to string for Database methods that expect string user_id
    const USER_ID = userId.toString();

    try {
      switch (name) {
        case 'search': {
          const query = args?.query as string;
          if (!query) {
            throw new Error('Query parameter is required');
          }

          console.log(`🔍 Executing search with query: "${query}" for user ${userId}`);
          const { start, end } = parseDateQuery(query);
          const lowerQuery = query.toLowerCase();

          const results: any[] = [];

          // Search in places if query contains place-related keywords or place names
          const places = await database.getAllPlaces(USER_ID);
          const searchPlaces = places.filter(
            (p) =>
              (p.name && lowerQuery.includes(p.name.toLowerCase())) ||
              (p.google_place_name && lowerQuery.includes(p.google_place_name.toLowerCase())) ||
              lowerQuery.includes('place') ||
              lowerQuery.includes('visit')
          );

          // Add place results
          for (const place of searchPlaces.slice(0, 10)) {
            results.push({
              id: `place:${place.id}`,
              title: `Place: ${place.name || place.google_place_name || '(unlabeled)'}`,
              text: `${place.name || place.google_place_name || 'Unnamed place'}. Visited ${place.visit_count || 0} times. Category: ${place.category || 'unknown'}`,
              url: `https://www.google.com/maps/search/?api=1&query=${place.center_lat},${place.center_lng}`,
            });
          }

          // Get recent visits
          if (start && end) {
            const visits = await database.getPlaceVisits(USER_ID, start, end);

            for (const visit of visits.slice(0, 20)) {
              const placeName =
                visit.place?.name || visit.place?.google_place_name || '(unlabeled)';
              results.push({
                id: `visit:${visit.id}`,
                title: `Visit: ${placeName}`,
                text: `Visited ${placeName} on ${new Date(visit.arrival_time).toLocaleString()}. Duration: ${visit.duration_minutes} minutes`,
                url: `https://www.google.com/maps/search/?api=1&query=${visit.place?.center_lat},${visit.place?.center_lng}`,
              });
            }
          }

          console.log(`✅ Search completed successfully. Found ${results.length} results`);

          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({ results }, null, 2),
              },
            ],
          };
        }

        case 'fetch': {
          const id = args?.id as string;
          if (!id) {
            throw new Error('ID parameter is required');
          }

          console.log(`📥 Executing fetch with id: "${id}" for user ${userId}`);
          const [type, itemId] = id.split(':');

          let result: any;

          if (type === 'place') {
            const places = await database.getAllPlaces(USER_ID);
            const place = places.find((p) => p.id === parseInt(itemId));

            if (!place) {
              throw new Error(`Place not found for ID: ${id}`);
            }

            result = {
              id,
              title: `Place: ${place.name || place.google_place_name || '(unlabeled)'}`,
              text: JSON.stringify(
                {
                  name: place.name,
                  googleName: place.google_place_name,
                  address: place.address,
                  category: place.category,
                  visitCount: place.visit_count,
                  coordinates: {
                    latitude: place.center_lat,
                    longitude: place.center_lng,
                  },
                },
                null,
                2
              ),
              url: `https://www.google.com/maps/search/?api=1&query=${place.center_lat},${place.center_lng}`,
              metadata: {
                type: 'place',
                retrieved_at: new Date().toISOString(),
              },
            };
          } else if (type === 'visit') {
            const allVisits = await database.getPlaceVisits(USER_ID);
            const visit = allVisits.find((v) => v.id === parseInt(itemId));

            if (!visit) {
              throw new Error(`Visit not found for ID: ${id}`);
            }

            result = {
              id,
              title: `Visit: ${visit.place?.name || '(unlabeled)'}`,
              text: JSON.stringify(
                {
                  place: {
                    name: visit.place?.name,
                    googleName: visit.place?.google_place_name,
                    category: visit.place?.category,
                  },
                  arrivalTime: visit.arrival_time,
                  departureTime: visit.departure_time,
                  durationMinutes: visit.duration_minutes,
                },
                null,
                2
              ),
              url: `https://www.google.com/maps/search/?api=1&query=${visit.place?.center_lat},${visit.place?.center_lng}`,
              metadata: {
                type: 'place_visit',
                retrieved_at: new Date().toISOString(),
              },
            };
          } else {
            throw new Error(`Unknown type: ${type}`);
          }

          console.log(`✅ Fetch completed successfully`);

          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify(result, null, 2),
              },
            ],
          };
        }

        case 'get_current_location': {
          const location = await database.getLatestLocation(USER_ID);
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify(
                  location
                    ? {
                        latitude: location.latitude,
                        longitude: location.longitude,
                        accuracy: location.accuracy,
                        timestamp: location.timestamp,
                        device: location.device_model,
                      }
                    : { message: 'No location data found' },
                  null,
                  2
                ),
              },
            ],
          };
        }

        case 'get_location_history': {
          const startDate = new Date(args?.start_date as string);
          const endDate = new Date(args?.end_date as string);
          const limit = (args?.limit as number) || 1000;

          const locations = await database.getLocationHistory(USER_ID, startDate, endDate, limit);

          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify(
                  {
                    date_range: { start: startDate, end: endDate },
                    total_points: locations.length,
                    locations: locations.map((l) => ({
                      latitude: l.latitude,
                      longitude: l.longitude,
                      accuracy: l.accuracy,
                      timestamp: l.timestamp,
                    })),
                  },
                  null,
                  2
                ),
              },
            ],
          };
        }

        case 'get_location_at_time': {
          const timestamp = new Date(args?.timestamp as string);
          const location = await database.getLocationAtTime(USER_ID, timestamp);

          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify(
                  location
                    ? {
                        requested_time: timestamp,
                        actual_time: location.timestamp,
                        latitude: location.latitude,
                        longitude: location.longitude,
                        accuracy: location.accuracy,
                      }
                    : {
                        message: 'No location found within 10 minutes of that time',
                      },
                  null,
                  2
                ),
              },
            ],
          };
        }

        case 'search_locations_near': {
          const lat = args?.latitude as number;
          const lng = args?.longitude as number;
          const radius = (args?.radius_meters as number) || 100;
          const startDate = args?.start_date ? new Date(args.start_date as string) : undefined;
          const endDate = args?.end_date ? new Date(args.end_date as string) : undefined;

          const locations = await database.getLocationsNear(
            USER_ID,
            lat,
            lng,
            radius,
            startDate,
            endDate
          );

          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify(
                  {
                    search_location: { latitude: lat, longitude: lng },
                    radius_meters: radius,
                    matches: locations.length,
                    locations: locations.map((l) => ({
                      timestamp: l.timestamp,
                      distance_meters: (l as any).distance_meters,
                      latitude: l.latitude,
                      longitude: l.longitude,
                    })),
                  },
                  null,
                  2
                ),
              },
            ],
          };
        }

        case 'get_frequent_places': {
          const places = await database.getAllPlaces(USER_ID);
          const sorted = places.sort((a, b) => (b.visit_count || 0) - (a.visit_count || 0));

          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify(
                  {
                    total_places: sorted.length,
                    places: sorted.map((p) => ({
                      id: p.id,
                      name: p.name || '(unlabeled)',
                      category: p.category,
                      visit_count: p.visit_count,
                      coordinates: {
                        latitude: p.center_lat,
                        longitude: p.center_lng,
                      },
                      google_name: p.google_place_name,
                      address: p.address,
                    })),
                  },
                  null,
                  2
                ),
              },
            ],
          };
        }

        case 'get_travel_stats': {
          const startDate = new Date(args?.start_date as string);
          const endDate = new Date(args?.end_date as string);

          const stats = await database.getTravelStats(USER_ID, startDate, endDate);

          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify(
                  {
                    date_range: {
                      start: startDate,
                      end: endDate,
                    },
                    total_distance_km: (stats.total_distance_meters / 1000).toFixed(2),
                    total_distance_miles: (stats.total_distance_meters / 1609.34).toFixed(2),
                    average_speed_mph:
                      stats.average_speed_mps > 0
                        ? (stats.average_speed_mps * 2.237).toFixed(1)
                        : 0,
                    max_speed_mph:
                      stats.max_speed_mps > 0 ? (stats.max_speed_mps * 2.237).toFixed(1) : 0,
                  },
                  null,
                  2
                ),
              },
            ],
          };
        }

        case 'list_all_places': {
          const places = await database.getAllPlaces(USER_ID);

          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify(
                  {
                    total: places.length,
                    labeled: places.filter((p) => p.name).length,
                    unlabeled: places.filter((p) => !p.name).length,
                    places: places.map((p) => ({
                      id: p.id,
                      name: p.name,
                      category: p.category,
                      visit_count: p.visit_count,
                      coordinates: {
                        latitude: p.center_lat,
                        longitude: p.center_lng,
                      },
                      google_name: p.google_place_name,
                      address: p.address,
                    })),
                  },
                  null,
                  2
                ),
              },
            ],
          };
        }

        case 'label_place': {
          const placeId = args?.place_id as number;
          const placeName = args?.name as string;
          const category = args?.category as string | undefined;

          const place = await database.labelPlace(USER_ID, placeId, placeName, category);

          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify(
                  place
                    ? {
                        message: 'Place labeled successfully',
                        place: {
                          id: place.id,
                          name: place.name,
                          category: place.category,
                          visit_count: place.visit_count,
                        },
                      }
                    : { error: 'Place not found' },
                  null,
                  2
                ),
              },
            ],
          };
        }

        case 'get_place_visits': {
          let placeId = args?.place_id as number | undefined;
          const placeName = args?.place_name as string | undefined;
          const startDate = args?.start_date ? new Date(args.start_date as string) : undefined;
          const endDate = args?.end_date ? new Date(args.end_date as string) : undefined;

          // If place name provided, find the place ID
          if (placeName && !placeId) {
            const places = await database.getAllPlaces(USER_ID);
            const place = places.find((p) => p.name === placeName);
            if (place) placeId = place.id;
          }

          const visits = await database.getPlaceVisits(USER_ID, startDate, endDate, placeId);

          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify(
                  {
                    total_visits: visits.length,
                    visits: visits.map((v) => ({
                      place: {
                        id: v.place?.id,
                        name: v.place?.name || '(unlabeled)',
                        category: v.place?.category,
                      },
                      arrival: v.arrival_time,
                      departure: v.departure_time,
                      duration_minutes: v.duration_minutes,
                    })),
                  },
                  null,
                  2
                ),
              },
            ],
          };
        }

        case 'get_time_at_place': {
          const placeId = args?.place_id as number | undefined;
          const placeName = args?.place_name as string | undefined;
          const startDate = new Date(args?.start_date as string);
          const endDate = new Date(args?.end_date as string);

          let targetPlaceId = placeId;

          if (placeName && !targetPlaceId) {
            const places = await database.getAllPlaces(USER_ID);
            const place = places.find((p) => p.name === placeName);
            if (place) targetPlaceId = place.id;
          }

          const visits = await database.getPlaceVisits(USER_ID, startDate, endDate, targetPlaceId);

          const totalMinutes = visits.reduce((sum, v) => sum + (v.duration_minutes || 0), 0);

          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify(
                  {
                    place_name: placeName || `Place ID ${targetPlaceId}`,
                    date_range: { start: startDate, end: endDate },
                    total_visits: visits.length,
                    total_time_minutes: totalMinutes,
                    total_time_hours: (totalMinutes / 60).toFixed(1),
                    average_visit_minutes:
                      visits.length > 0 ? (totalMinutes / visits.length).toFixed(1) : 0,
                  },
                  null,
                  2
                ),
              },
            ],
          };
        }

        case 'enrich_place_with_google': {
          if (!googlePlaces) {
            return {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify({
                    error: 'Google Places API key not configured',
                  }),
                },
              ],
              isError: true,
            };
          }

          const placeId = args?.place_id as number;
          const places = await database.getAllPlaces(USER_ID);
          const place = places.find((p) => p.id === placeId);

          if (!place) {
            return {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify({ error: 'Place not found' }),
                },
              ],
              isError: true,
            };
          }

          const googleData = await googlePlaces.reverseGeocode(place.center_lat, place.center_lng);

          if (googleData && googleData.google_place_id) {
            const category = googleData.google_place_types
              ? googlePlaces.inferCategory(googleData.google_place_types)
              : undefined;

            await database.upsertPlace({
              ...place,
              ...googleData,
              category: category || place.category,
            });

            return {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify(
                    {
                      message: 'Place enriched with Google data',
                      place: {
                        id: place.id,
                        google_name: googleData.google_place_name,
                        address: googleData.address,
                        category,
                      },
                    },
                    null,
                    2
                  ),
                },
              ],
            };
          }

          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  message: 'No Google Places data found for this location',
                }),
              },
            ],
          };
        }

        case 'get_unlabeled_frequent_places': {
          const minVisits = (args?.min_visits as number) || 3;
          const places = await placesAnalyzer.getUnlabeledFrequentPlaces(USER_ID, minVisits);

          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify(
                  {
                    message: `Found ${places.length} unlabeled places with ${minVisits}+ visits`,
                    suggestion: 'Use label_place tool to name these places (e.g., "Home", "Work")',
                    places: places.map((p) => ({
                      id: p.id,
                      visit_count: p.visit_count,
                      coordinates: {
                        latitude: p.center_lat,
                        longitude: p.center_lng,
                      },
                      google_name: p.google_place_name,
                      address: p.address,
                    })),
                  },
                  null,
                  2
                ),
              },
            ],
          };
        }

        case 'process_recent_locations': {
          const processed = await placesAnalyzer.processUnprocessedLocations(USER_ID);

          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify(
                  {
                    message: `Processed ${processed} location points`,
                    suggestion:
                      'Run get_unlabeled_frequent_places to see if any new places need labeling',
                  },
                  null,
                  2
                ),
              },
            ],
          };
        }

        default:
          throw new Error(`Unknown tool: ${name}`);
      }
    } catch (error) {
      console.error(`❌ Tool execution failed for ${name}:`, error);
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              error: error instanceof Error ? error.message : String(error),
              tool: name,
            }),
          },
        ],
        isError: true,
      };
    }
  });
}

// SSE endpoint for MCP with OAuth authentication
const transports: Map<string, SSEServerTransport> = new Map();

/**
 * SSE Endpoint Handler - Main MCP connection endpoint
 * Requires Bearer token authentication in Authorization header
 * This handler is reused for both /sse and /SSE routes (case-insensitive)
 */
async function handleSSEConnection(req: any, res: any) {
  console.log('📡 SSE connection request received');

  // Extract Bearer token from Authorization header
  const authHeader = req.headers.authorization;
  let accessToken: string | undefined;

  if (authHeader?.startsWith('Bearer ')) {
    accessToken = authHeader.substring(7);
    console.log('✅ Bearer token found in Authorization header');
  }

  if (!accessToken) {
    console.warn('⚠️  No access token provided, returning 401');
    res.setHeader(
      'WWW-Authenticate',
      `Bearer resource_metadata="${PUBLIC_URL}/.well-known/oauth-protected-resource"`
    );
    return res.status(401).json({
      error: 'unauthorized',
      error_description:
        'Bearer token required. Discover OAuth endpoints via /.well-known/oauth-protected-resource',
      oauth_metadata: `${PUBLIC_URL}/.well-known/oauth-protected-resource`,
    });
  }

  // Validate token with backend
  try {
    const userId = await getUserIdFromToken(accessToken);
    console.log(`✅ Token validated for user ID: ${userId}`);
  } catch (error) {
    console.error('❌ Token validation failed:', error);
    return res.status(401).json({
      error: 'invalid_token',
      error_description: 'The access token is invalid or expired',
    });
  }

  const sessionId = uuidv4();
  const userId = await getUserIdFromToken(accessToken);
  sessionTokens.set(sessionId, accessToken);
  sessionUsers.set(sessionId, userId);
  console.log(`📝 Created SSE session: ${sessionId} for user ${userId}`);

  // CRITICAL: Use /message (singular) not /messages (plural) for Deep Research compatibility
  // This is a P0 requirement - using /messages breaks ChatGPT integration
  const transport = new SSEServerTransport('/message', res);

  // Set 6-hour timeout for long-lived SSE connection
  res.setTimeout(1000 * 60 * 60 * 6);

  transports.set(sessionId, transport);

  (transport as any).onclose = () => {
    console.log(`🔌 SSE transport closed for session ${sessionId}`);
    transports.delete(sessionId);
    sessionTokens.delete(sessionId);
    sessionUsers.delete(sessionId);
  };

  console.log('🔌 Connecting MCP server with SSE transport...');

  await sessionContext.run(sessionId, async () => {
    await mcpServer.connect(transport);
    console.log(`✅ MCP server connected for session: ${sessionId}`);
  });

  res.on('close', () => {
    sessionTokens.delete(sessionId);
    sessionUsers.delete(sessionId);
    console.log(`🔌 SSE connection closed, session cleaned up: ${sessionId}`);
  });
}

// Register SSE endpoint handlers for both lowercase and uppercase
// Some MCP clients (like Claude) use uppercase /SSE
app.get('/sse', handleSSEConnection);
app.get('/SSE', handleSSEConnection);

/**
 * Message Endpoint Handler - Routes messages to correct SSE session
 * This is critical for MCP protocol message routing
 * This handler is reused for both /message and /MESSAGE routes (case-insensitive)
 */
async function handleMessagePost(req: any, res: any) {
  const sessionId = req.query.sessionId as string;

  if (!sessionId) {
    return res.status(400).send('Missing sessionId parameter');
  }

  const transport = transports.get(sessionId);

  if (!transport) {
    return res.status(404).json({ error: 'Session not found' });
  }

  try {
    // CRITICAL: Pass 3 parameters - req, res, AND req.body
    // This is the working pattern from whoop-mcp-server
    return await transport.handlePostMessage(req, res, req.body);
  } catch (error) {
    console.error(`Error handling message:`, error);
    if (!res.headersSent) {
      return res.status(500).json({ error: 'Internal server error' });
    }
  }
}

// Register message endpoint handlers for both lowercase and uppercase
// Some MCP clients may use uppercase /MESSAGE
app.post('/message', handleMessagePost);
app.post('/MESSAGE', handleMessagePost);

// Upload endpoint for iOS app - requires Bearer token authentication
app.post('/upload', async (req, res) => {
  try {
    // Validate Bearer token
    const authHeader = req.headers.authorization;
    let accessToken: string | undefined;

    if (authHeader?.startsWith('Bearer ')) {
      accessToken = authHeader.substring(7);
    }

    if (!accessToken) {
      return res.status(401).json({
        error: 'unauthorized',
        error_description: 'Bearer token required in Authorization header',
      });
    }

    // Validate token and get user ID
    let userId: number;
    try {
      userId = await getUserIdFromToken(accessToken);
      console.log(`✅ Upload authorized for user ${userId}`);
    } catch (error) {
      return res.status(401).json({
        error: 'invalid_token',
        error_description: 'The access token is invalid or expired',
      });
    }

    const USER_ID = userId.toString();
    const payload = req.body as LocationUploadPayload;

    if (!payload.locations || !Array.isArray(payload.locations)) {
      return res.status(400).json({ error: 'Invalid locations data' });
    }

    console.log(
      `📤 Received ${payload.locations.length} location points from ${payload.device?.model || 'unknown device'} for user ${userId}`
    );

    // Convert to database format
    const locationPoints = payload.locations.map((loc) => ({
      user_id: USER_ID,
      latitude: loc.latitude,
      longitude: loc.longitude,
      accuracy: loc.accuracy,
      altitude: loc.altitude,
      altitude_accuracy: loc.altitudeAccuracy,
      speed: loc.speed,
      course: loc.course,
      timestamp: new Date(loc.timestamp),
      local_timezone: loc.timezone,
      device_model: payload.device.model,
      device_os: payload.device.os,
      app_version: payload.device.appVersion,
    }));

    // Store in database
    const inserted = await database.storeLocations(locationPoints);

    // Trigger background processing (place detection)
    // Run async without blocking response
    placesAnalyzer
      .processUnprocessedLocations(USER_ID)
      .then((processed) => {
        console.log(
          `🔍 Background processing: ${processed} locations processed for user ${userId}`
        );
      })
      .catch((err) => {
        console.error('❌ Background processing error:', err);
      });

    return res.json({
      success: true,
      received: payload.locations.length,
      inserted,
      message: 'Locations stored successfully',
    });
  } catch (error) {
    console.error('❌ Upload error:', error);
    return res.status(500).json({
      error: 'Failed to process upload',
      details: error instanceof Error ? error.message : String(error),
    });
  }
});

// Start server
app.listen(parseInt(PORT as string), HOST, () => {
  console.log('');
  console.log('============================================================');
  console.log('✅ Location History MCP Server (OAuth) is running');
  console.log('============================================================');
  console.log('');
  console.log(`🌐 Server URL:           http://${HOST}:${PORT}`);
  console.log(`🔐 OAuth Metadata:       ${PUBLIC_URL}/.well-known/oauth-protected-resource`);
  console.log(`📡 SSE Endpoint:         ${PUBLIC_URL}/sse`);
  console.log(`📤 Upload Endpoint:      ${PUBLIC_URL}/upload`);
  console.log(`🔧 Health Check:         ${PUBLIC_URL}/health`);
  console.log('');
  console.log('🔐 OAuth Configuration:');
  console.log(`   Backend:   ${BACKEND_URL}`);
  console.log(`   Client ID: ${OAUTH_CLIENT_ID}`);
  console.log('');
  console.log('📝 For ChatGPT Deep Research:');
  console.log('   1. The service will auto-discover OAuth via RFC 9728');
  console.log(`   2. Users will be redirected to ${BACKEND_URL} for authentication`);
  console.log(`   3. After auth, they'll return to ${PUBLIC_URL}/oauth/callback`);
  console.log('');
  console.log('🧪 Test the server:');
  console.log(`   curl ${PUBLIC_URL}/health`);
  console.log(`   curl ${PUBLIC_URL}/.well-known/oauth-protected-resource`);
  console.log('');
  console.log('============================================================');
});
