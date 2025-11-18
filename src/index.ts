#!/usr/bin/env node

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  Tool,
} from '@modelcontextprotocol/sdk/types.js';
import express from 'express';
import dotenv from 'dotenv';
import geoTz from 'geo-tz';
import { Database } from './database.js';
import { PlacesAnalyzer } from './places-analyzer.js';
import { GooglePlacesClient } from './google-places.js';
import { LocationUploadPayload } from './types.js';

dotenv.config();

// Configuration
const PORT = process.env.PORT || 8000;
const HOST = process.env.HOST || '0.0.0.0';
const DB_CONNECTION_STRING =
  process.env.DATABASE_URL ||
  'postgresql://user:pass@localhost:5432/health_data';
const GOOGLE_PLACES_API_KEY = process.env.GOOGLE_PLACES_API_KEY || '';
const USER_ID = process.env.DEFAULT_USER_ID || 'lucas@example.com';

// Initialize services
const database = new Database(DB_CONNECTION_STRING);
const placesAnalyzer = new PlacesAnalyzer(database);
const googlePlaces = GOOGLE_PLACES_API_KEY
  ? new GooglePlacesClient(GOOGLE_PLACES_API_KEY)
  : null;

// Initialize database schema
await database.initialize();

// Create MCP server
const server = new Server(
  {
    name: 'location-history-mcp-server',
    version: '1.0.0',
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

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
    description:
      'Find where you were at a specific time (finds closest match within 10 minutes)',
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
    description:
      'Get your most frequently visited places, ordered by visit count',
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
    description:
      'Give a name and category to a place (e.g., "Home", "Work", "Equinox Gym")',
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
          description:
            'Optional category: home, work, gym, restaurant, store, etc.',
        },
      },
      required: ['place_id', 'name'],
    },
  },
  {
    name: 'get_place_visits',
    description:
      'Get all visits to a specific place or all places within a date range',
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
    description:
      'Calculate total time spent at a place (by name or ID) within a date range',
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
    description:
      'Use Google Places API to get business name and details for a place',
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
      'Find frequently visited places that haven\'t been labeled yet. Suggests places you should name.',
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
    description:
      'Trigger place detection and clustering for recent unprocessed location data',
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
    const yesterdayStart = new Date(yesterday.getFullYear(), yesterday.getMonth(), yesterday.getDate());
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

// Tool handlers
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return { tools };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  console.log(`🔧 Tool called: ${name}`, JSON.stringify(args));

  try {
    switch (name) {
      case 'search': {
        const query = args?.query as string;
        if (!query) {
          throw new Error('Query parameter is required');
        }

        console.log(`🔍 Executing search with query: "${query}"`);
        const { start, end } = parseDateQuery(query);
        const lowerQuery = query.toLowerCase();

        const results: any[] = [];

        // Search in places if query contains place-related keywords or place names
        const places = await database.getAllPlaces(USER_ID);
        const searchPlaces = places.filter(p =>
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
            const placeName = visit.place?.name || visit.place?.google_place_name || '(unlabeled)';
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

        console.log(`📥 Executing fetch with id: "${id}"`);
        const [type, itemId] = id.split(':');

        let result: any;

        if (type === 'place') {
          const places = await database.getAllPlaces(USER_ID);
          const place = places.find(p => p.id === parseInt(itemId));

          if (!place) {
            throw new Error(`Place not found for ID: ${id}`);
          }

          result = {
            id,
            title: `Place: ${place.name || place.google_place_name || '(unlabeled)'}`,
            text: JSON.stringify({
              name: place.name,
              googleName: place.google_place_name,
              address: place.address,
              category: place.category,
              visitCount: place.visit_count,
              coordinates: {
                latitude: place.center_lat,
                longitude: place.center_lng,
              },
            }, null, 2),
            url: `https://www.google.com/maps/search/?api=1&query=${place.center_lat},${place.center_lng}`,
            metadata: {
              type: 'place',
              retrieved_at: new Date().toISOString(),
            },
          };
        } else if (type === 'visit') {
          const allVisits = await database.getPlaceVisits(USER_ID);
          const visit = allVisits.find(v => v.id === parseInt(itemId));

          if (!visit) {
            throw new Error(`Visit not found for ID: ${id}`);
          }

          result = {
            id,
            title: `Visit: ${visit.place?.name || '(unlabeled)'}`,
            text: JSON.stringify({
              place: {
                name: visit.place?.name,
                googleName: visit.place?.google_place_name,
                category: visit.place?.category,
              },
              arrivalTime: visit.arrival_time,
              departureTime: visit.departure_time,
              durationMinutes: visit.duration_minutes,
            }, null, 2),
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

        const locations = await database.getLocationHistory(
          USER_ID,
          startDate,
          endDate,
          limit
        );

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
        const startDate = args?.start_date
          ? new Date(args.start_date as string)
          : undefined;
        const endDate = args?.end_date
          ? new Date(args.end_date as string)
          : undefined;

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
        const sorted = places.sort(
          (a, b) => (b.visit_count || 0) - (a.visit_count || 0)
        );

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
                  total_distance_km: (stats.total_distance_meters / 1000).toFixed(
                    2
                  ),
                  total_distance_miles: (
                    stats.total_distance_meters / 1609.34
                  ).toFixed(2),
                  average_speed_mph:
                    stats.average_speed_mps > 0
                      ? (stats.average_speed_mps * 2.237).toFixed(1)
                      : 0,
                  max_speed_mph:
                    stats.max_speed_mps > 0
                      ? (stats.max_speed_mps * 2.237).toFixed(1)
                      : 0,
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
        const name = args?.name as string;
        const category = args?.category as string | undefined;

        const place = await database.labelPlace(USER_ID, placeId, name, category);

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
        const startDate = args?.start_date
          ? new Date(args.start_date as string)
          : undefined;
        const endDate = args?.end_date
          ? new Date(args.end_date as string)
          : undefined;

        // If place name provided, find the place ID
        if (placeName && !placeId) {
          const places = await database.getAllPlaces(USER_ID);
          const place = places.find((p) => p.name === placeName);
          if (place) placeId = place.id;
        }

        const visits = await database.getPlaceVisits(
          USER_ID,
          startDate,
          endDate,
          placeId
        );

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

        const visits = await database.getPlaceVisits(
          USER_ID,
          startDate,
          endDate,
          targetPlaceId
        );

        const totalMinutes = visits.reduce(
          (sum, v) => sum + (v.duration_minutes || 0),
          0
        );

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
                    visits.length > 0
                      ? (totalMinutes / visits.length).toFixed(1)
                      : 0,
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

        const googleData = await googlePlaces.reverseGeocode(
          place.center_lat,
          place.center_lng
        );

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
        const places = await placesAnalyzer.getUnlabeledFrequentPlaces(
          USER_ID,
          minVisits
        );

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  message: `Found ${places.length} unlabeled places with ${minVisits}+ visits`,
                  suggestion:
                    'Use label_place tool to name these places (e.g., "Home", "Work")',
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
        const processed = await placesAnalyzer.processUnprocessedLocations(
          USER_ID
        );

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

// Express app for HTTP endpoints
const app = express();

app.use((req, res, next) => {
  if (req.path === '/message') {
    next();
  } else {
    express.json()(req, res, next);
  }
});

// SSE transport for MCP
const transports: Map<string, SSEServerTransport> = new Map();

app.get('/sse', async (req, res) => {
  console.log('SSE client connected');

  const transport = new SSEServerTransport('/message', res);
  const sessionId = (transport as any).sessionId;
  console.log(`Established SSE stream with session ID: ${sessionId}`);

  transports.set(sessionId, transport);

  (transport as any).onclose = () => {
    console.log(`SSE transport closed for session ${sessionId}`);
    transports.delete(sessionId);
  };

  await server.connect(transport);
});

app.post('/message', async (req, res) => {
  const sessionId = req.query.sessionId as string;

  if (!sessionId) {
    res.status(400).send('Missing sessionId parameter');
    return;
  }

  const transport = transports.get(sessionId);

  if (!transport) {
    res.status(404).json({ error: 'Session not found' });
    return;
  }

  try {
    await transport.handlePostMessage(req, res);
  } catch (error) {
    console.error(`Error handling message:`, error);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Internal server error' });
    }
  }
});

// Upload endpoint for iOS app
app.post('/upload', async (req, res) => {
  try {
    const payload = req.body as LocationUploadPayload;

    if (!payload.locations || !Array.isArray(payload.locations)) {
      return res.status(400).json({ error: 'Invalid locations data' });
    }

    console.log(
      `📤 Received ${payload.locations.length} location points from ${payload.device?.model || 'unknown device'}`
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
        console.log(`🔍 Background processing: ${processed} locations processed`);
      })
      .catch((err) => {
        console.error('❌ Background processing error:', err);
      });

    res.json({
      success: true,
      received: payload.locations.length,
      inserted,
      message: 'Locations stored successfully',
    });
  } catch (error) {
    console.error('❌ Upload error:', error);
    res.status(500).json({
      error: 'Failed to process upload',
      details: error instanceof Error ? error.message : String(error),
    });
  }
});

// REFERENCE: How to convert bad timestamps (should have used this instead of deleting!)
// Fix timestamps that were sent as seconds but interpreted as milliseconds
app.post('/debug/fix-timestamps', async (req, res) => {
  try {
    const client = await database['pool'].connect();
    try {
      // The bug: iOS sent timestamps as seconds (e.g., 1730500000)
      // JavaScript interpreted as milliseconds, storing dates in Jan 1970
      // Fix: multiply epoch seconds by 1000 to get correct timestamp

      const updateResult = await client.query(`
        UPDATE location_points
        SET timestamp = to_timestamp(EXTRACT(EPOCH FROM timestamp) * 1000)
        WHERE user_id = $1
          AND timestamp < '2020-01-01'
      `, [USER_ID]);

      res.json({
        message: 'Fixed timestamp encoding',
        updated_count: updateResult.rowCount,
        user_id: USER_ID,
        explanation: 'Converted timestamps from milliseconds interpretation to seconds'
      });
    } finally {
      client.release();
    }
  } catch (error) {
    console.error('Fix timestamps error:', error);
    res.status(500).json({ error: String(error) });
  }
});

// Clear bad timestamp data (one-time cleanup) - DEPRECATED, should use fix-timestamps instead
app.post('/debug/clear-bad-timestamps', async (req, res) => {
  try {
    const client = await database['pool'].connect();
    try {
      // First, get count of what will be deleted
      const countResult = await client.query(`
        SELECT COUNT(*) as count
        FROM location_points
        WHERE user_id = $1
          AND timestamp < '2020-01-01'
      `, [USER_ID]);

      // Delete the bad data
      const deleteResult = await client.query(`
        DELETE FROM location_points
        WHERE user_id = $1
          AND timestamp < '2020-01-01'
      `, [USER_ID]);

      res.json({
        message: 'Cleared bad timestamp data',
        deleted_count: deleteResult.rowCount,
        confirmed_count: countResult.rows[0].count,
        user_id: USER_ID
      });
    } finally {
      client.release();
    }
  } catch (error) {
    console.error('Clear bad timestamps error:', error);
    res.status(500).json({ error: String(error) });
  }
});

// Debug endpoint to see sample data
app.get('/debug/sample', async (req, res) => {
  try {
    const client = await database['pool'].connect();
    try {
      const result = await client.query(`
        SELECT
          id, latitude, longitude, timestamp, device_model,
          accuracy, created_at
        FROM location_points
        WHERE user_id = $1
        ORDER BY created_at DESC
        LIMIT 20
      `, [USER_ID]);

      res.json({
        user_id: USER_ID,
        sample_count: result.rows.length,
        samples: result.rows,
      });
    } finally {
      client.release();
    }
  } catch (error) {
    console.error('Debug sample error:', error);
    res.status(500).json({ error: String(error) });
  }
});

// Debug endpoint to check database contents
app.get('/debug/stats', async (req, res) => {
  try {
    const client = await database['pool'].connect();
    try {
      const result = await client.query(`
        SELECT
          COUNT(*) as total_points,
          COUNT(DISTINCT user_id) as unique_users,
          COUNT(DISTINCT DATE(timestamp)) as unique_days,
          MIN(timestamp) as earliest,
          MAX(timestamp) as latest,
          COUNT(CASE WHEN place_id IS NOT NULL THEN 1 END) as assigned_to_place,
          COUNT(CASE WHEN place_id IS NULL THEN 1 END) as unprocessed
        FROM location_points
        WHERE user_id = $1
      `, [USER_ID]);

      const recentResult = await client.query(`
        SELECT
          DATE(timestamp) as date,
          COUNT(*) as point_count
        FROM location_points
        WHERE user_id = $1
          AND timestamp >= NOW() - INTERVAL '30 days'
        GROUP BY DATE(timestamp)
        ORDER BY date DESC
        LIMIT 30
      `, [USER_ID]);

      res.json({
        user_id: USER_ID,
        overall: result.rows[0],
        last_30_days: recentResult.rows,
      });
    } finally {
      client.release();
    }
  } catch (error) {
    console.error('Debug stats error:', error);
    res.status(500).json({ error: String(error) });
  }
});

// REST API endpoint for daily location summary (used by insights aggregator)
app.get('/api/daily', async (req, res) => {
  try {
    const { date, userId } = req.query;

    if (!date) {
      return res.status(400).json({ error: 'date parameter is required (YYYY-MM-DD)' });
    }

    const userIdToUse = (userId as string) || USER_ID;

    // Parse date and create start/end of day
    const dateObj = new Date(date as string);
    const startOfDay = new Date(dateObj);
    startOfDay.setHours(0, 0, 0, 0);
    const endOfDay = new Date(dateObj);
    endOfDay.setHours(23, 59, 59, 999);

    console.log(`📍 Fetching location data for user ${userIdToUse} on ${date}`);

    // Get place visits for the day
    const visits = await database.getPlaceVisits(userIdToUse, startOfDay, endOfDay);

    // Get location history to calculate movement activities
    const locations = await database.getLocationHistory(userIdToUse, startOfDay, endOfDay, 1000);

    // Format places visited
    const places = visits.map(v => ({
      name: v.place?.name || v.place?.google_place_name || '(unnamed place)',
      address: v.place?.address || '',
      startTime: v.arrival_time?.toISOString() || '',
      endTime: v.departure_time?.toISOString() || '',
      duration_minutes: v.duration_minutes || 0,
    }));

    // Calculate activities from location points
    // Group consecutive points with similar speeds to identify activity types
    const activities: Array<{ type: string; distance_meters: number; duration_minutes: number }> = [];

    // Simple activity detection based on speed
    let currentActivity: { type: string; startIdx: number; distance: number } | null = null;

    for (let i = 1; i < locations.length; i++) {
      const prev = locations[i - 1];
      const curr = locations[i];

      // Calculate distance using Haversine formula (simplified)
      const R = 6371000; // Earth's radius in meters
      const dLat = (curr.latitude - prev.latitude) * Math.PI / 180;
      const dLon = (curr.longitude - prev.longitude) * Math.PI / 180;
      const a = Math.sin(dLat/2) * Math.sin(dLat/2) +
                Math.cos(prev.latitude * Math.PI / 180) * Math.cos(curr.latitude * Math.PI / 180) *
                Math.sin(dLon/2) * Math.sin(dLon/2);
      const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
      const distance = R * c;

      const timeDiff = (curr.timestamp.getTime() - prev.timestamp.getTime()) / 1000; // seconds
      const speedMps = timeDiff > 0 ? distance / timeDiff : 0;

      // Classify activity by speed
      let activityType = 'STATIONARY';
      if (speedMps > 10) activityType = 'DRIVING'; // > 36 km/h
      else if (speedMps > 2) activityType = 'CYCLING'; // 7-36 km/h
      else if (speedMps > 0.5) activityType = 'WALKING'; // 1.8-7 km/h

      // Continue or start new activity
      if (currentActivity && currentActivity.type === activityType) {
        currentActivity.distance += distance;
      } else {
        // Save previous activity if significant
        if (currentActivity && currentActivity.distance > 50) { // min 50m
          const duration = (curr.timestamp.getTime() - locations[currentActivity.startIdx].timestamp.getTime()) / 60000;
          activities.push({
            type: currentActivity.type,
            distance_meters: Math.round(currentActivity.distance),
            duration_minutes: Math.round(duration),
          });
        }

        // Start new activity
        if (activityType !== 'STATIONARY') {
          currentActivity = {
            type: activityType,
            startIdx: i,
            distance: distance,
          };
        } else {
          currentActivity = null;
        }
      }
    }

    // Save final activity
    if (currentActivity && currentActivity.distance > 50) {
      const lastPoint = locations[locations.length - 1];
      const startPoint = locations[currentActivity.startIdx];
      const duration = (lastPoint.timestamp.getTime() - startPoint.timestamp.getTime()) / 60000;
      activities.push({
        type: currentActivity.type,
        distance_meters: Math.round(currentActivity.distance),
        duration_minutes: Math.round(duration),
      });
    }

    console.log(`✅ Found ${places.length} places and ${activities.length} activities for ${date}`);

    res.json({
      date: date,
      userId: userIdToUse,
      places: places,
      activities: activities,
      _metadata: {
        totalLocationPoints: locations.length,
        totalVisits: visits.length,
      },
    });
  } catch (error) {
    console.error('❌ Error fetching daily location data:', error);
    res.status(500).json({
      error: 'Failed to fetch location data',
      details: error instanceof Error ? error.message : String(error),
    });
  }
});

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    service: 'location-history-mcp-server',
    database: 'connected',
    tools: tools.length,
  });
});

app.get('/tools', (req, res) => {
  res.json({ tools });
});

// Migration endpoint to backfill timezones
app.post('/migrate/timezones', async (req, res) => {
  console.log('🔄 Starting timezone backfill migration...');

  try {
    // Get count of records without timezone
    const countResult = await database.query(`
      SELECT COUNT(*) as count
      FROM location_points
      WHERE local_timezone IS NULL
    `);
    const totalRecords = parseInt(countResult.rows[0].count);

    if (totalRecords === 0) {
      console.log('✅ No records need timezone backfill!');
      return res.json({
        status: 'complete',
        message: 'No records need timezone backfill',
        processed: 0,
        updated: 0,
      });
    }

    console.log(`📊 Found ${totalRecords} records without timezone`);

    let updatedCount = 0;
    let errorCount = 0;
    let offset = 0;
    const batchSize = 100;

    while (offset < totalRecords) {
      // Fetch batch
      const result = await database.query(`
        SELECT id, latitude, longitude
        FROM location_points
        WHERE local_timezone IS NULL
        ORDER BY id
        LIMIT $1 OFFSET $2
      `, [batchSize, offset]);

      const batch = result.rows;
      if (batch.length === 0) break;

      // Process each record
      for (const record of batch) {
        try {
          const timezones = geoTz.find(record.latitude, record.longitude);
          const timezone = timezones[0];

          if (timezone) {
            await database.query(`
              UPDATE location_points
              SET local_timezone = $1
              WHERE id = $2
            `, [timezone, record.id]);
            updatedCount++;
          } else {
            errorCount++;
          }
        } catch (error) {
          console.error(`Error processing record ${record.id}:`, error);
          errorCount++;
        }
      }

      offset += batchSize;
      console.log(`📈 Progress: ${offset}/${totalRecords} - Updated: ${updatedCount}, Errors: ${errorCount}`);
    }

    console.log('✅ Migration complete!');
    res.json({
      status: 'complete',
      totalRecords,
      updated: updatedCount,
      errors: errorCount,
    });
  } catch (error) {
    console.error('❌ Migration failed:', error);
    res.status(500).json({
      status: 'error',
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

// Start server
async function main() {
  console.log('🚀 Starting Location History MCP Server...');
  console.log(`📊 Database: ${DB_CONNECTION_STRING.includes('cloudsql') ? 'Cloud SQL' : 'PostgreSQL'}`);
  console.log(`🗺️  Google Places API: ${googlePlaces ? 'Enabled' : 'Disabled'}`);
  console.log(`👤 Default User: ${USER_ID}`);

  app.listen(Number(PORT), HOST, () => {
    console.log(`✅ Server running at http://${HOST}:${PORT}`);
    console.log(`📡 SSE endpoint: http://${HOST}:${PORT}/sse`);
    console.log(`❤️  Health check: http://${HOST}:${PORT}/health`);
    console.log(`📤 Upload endpoint: http://${HOST}:${PORT}/upload`);
    console.log(`🔧 ${tools.length} MCP tools available`);
  });
}

main().catch((error) => {
  console.error('Failed to start server:', error);
  process.exit(1);
});
