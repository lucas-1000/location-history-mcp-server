# Location History MCP Server - Claude Code Guide

**Production MCP server for personal GPS tracking with place recognition and timeline analysis**

---

## What This Service Does

Location History MCP Server provides comprehensive location tracking and analysis through the Model Context Protocol. It integrates with PostgreSQL/PostGIS to store GPS coordinates, uses Google Maps API for place recognition (home, work, gym, etc.), calculates visit durations, identifies activity patterns, and provides timeline queries. Features OAuth 2.1 authentication for Claude integration.

---

## Architecture

**Tech Stack:**
- TypeScript/Node.js with MCP SDK
- Express for HTTP/OAuth endpoints
- SSE (Server-Sent Events) transport for MCP
- PostgreSQL with PostGIS extension for geospatial queries
- Google Maps Places API for location enrichment
- geo-tz for timezone detection from coordinates
- Deploys to: Google Cloud Run

**Dependencies:**
- `@modelcontextprotocol/sdk` - MCP protocol implementation
- `express` - HTTP server for OAuth flows
- `pg` - PostgreSQL client with PostGIS support
- `@googlemaps/google-maps-services-js` - Google Maps API client
- `@google-cloud/secret-manager` - Credential management
- `geo-tz` - Timezone lookup from lat/lng
- `uuid` - Session ID generation

---

## Common Commands

### Development
```bash
npm install              # Install dependencies
npm run build            # Build TypeScript (creates build/ directory)
npm run dev              # Development mode with auto-reload (tsx watch)
npm start                # Start production server (MCP via stdio)
npm run inspector        # Launch MCP Inspector for debugging
```

### Deployment
```bash
# Deploy with OAuth support (REQUIRED for Claude)
GOOGLE_CLOUD_PROJECT=personal-assistant-e4351 \
OAUTH_CLIENT_SECRET='<secret-from-database>' \
./deploy-oauth.sh

# Note: Always run 'npm run build' before deploying
```

**Required Environment Variables:**
- `GOOGLE_CLOUD_PROJECT` - GCP project ID (personal-assistant-e4351)
- `OAUTH_CLIENT_ID` - OAuth client identifier (location-mcp-production)
- `OAUTH_CLIENT_SECRET` - OAuth client secret from database
- `BACKEND_URL` - Health data storage API URL
- `DATABASE_URL` - PostgreSQL connection string (Cloud SQL with PostGIS)
- `GOOGLE_MAPS_API_KEY` - Google Maps API key for place lookups
- `NODE_ENV` - Environment (production/development)

---

## Approval Gates

The following areas require explicit user approval before changes:

### Authentication & Security
- OAuth flow implementation (`src/http-server-oauth.ts`)
- RFC 9728 metadata endpoints (`.well-known/*`)
- Location data privacy handling
- Secret Manager integration

### Database & Storage
- PostGIS schema changes (spatial indexes, geometry columns)
- Location data retention policies
- Privacy-sensitive query patterns
- Geospatial query optimization

### Infrastructure
- Deployment scripts (`deploy.sh`, `deploy-oauth.sh`)
- Cloud Build configuration (`cloudbuild.yaml`)
- Dockerfile changes
- Environment variable configuration

### API Contracts
- MCP tool definitions (breaking changes to schemas)
- Location data format changes
- Timeline query response structure
- Privacy boundary definitions

### Privacy & Data
- Location logging patterns
- Data retention and deletion
- Place recognition accuracy
- Geographic privacy zones (home address, etc.)

---

## Key Files

| File | Purpose |
|------|---------|
| `src/index.ts` | MCP server implementation with location tracking tools |
| `src/http-server-oauth.ts` | OAuth workaround routes for Claude integration |
| `deploy-oauth.sh` | Cloud Run deployment with OAuth support |
| `cloudbuild.yaml` | Cloud Build configuration for containerization |

---

## MCP Tools

This server provides the following tools for Claude/ChatGPT:

### `location_log_update`
Log a new location update with GPS coordinates.

**Input:**
```json
{
  "user_id": "...",
  "latitude": 37.7749,
  "longitude": -122.4194,
  "timestamp": "2025-11-22T12:00:00Z",
  "accuracy": 10.5,
  "activity_type": "stationary"
}
```

**Returns:** Confirmation with place recognition results

### `location_query_timeline`
Get location timeline for a date range.

**Input:**
```json
{
  "user_id": "...",
  "start_date": "2025-11-22",
  "end_date": "2025-11-22"
}
```

**Returns:** Timeline with places visited, durations, activity types

### `location_query_place`
Get all visits to a specific place.

**Input:**
```json
{
  "user_id": "...",
  "place_name": "Home",
  "start_date": "2025-11-01",
  "end_date": "2025-11-22"
}
```

**Returns:** Array of visits with timestamps and durations

### `location_get_current`
Get most recent location.

**Input:**
```json
{
  "user_id": "..."
}
```

**Returns:** Latest GPS coordinates with place info

### `location_analyze_patterns`
Analyze location patterns over time.

**Input:**
```json
{
  "user_id": "...",
  "start_date": "2025-11-01",
  "end_date": "2025-11-22",
  "analysis_type": "daily_summary"
}
```

**Returns:**
- Places visited per day
- Time spent at each location
- Travel patterns
- Activity distribution

### `location_get_nearby_history`
Find historical visits near a coordinate.

**Input:**
```json
{
  "user_id": "...",
  "latitude": 37.7749,
  "longitude": -122.4194,
  "radius_meters": 100,
  "limit": 10
}
```

**Returns:** Past visits within radius, sorted by recency

---

## PostGIS Integration

The server uses PostgreSQL with PostGIS extension for geospatial queries:

**Spatial Features:**
- Point geometry for GPS coordinates
- Geographic distance calculations (ST_Distance)
- Spatial indexes for fast radius queries
- Timezone detection from coordinates

**Schema:**
```sql
CREATE TABLE location_history (
  id SERIAL PRIMARY KEY,
  user_id VARCHAR(255) NOT NULL,
  coordinates GEOGRAPHY(POINT, 4326),
  timestamp TIMESTAMPTZ NOT NULL,
  accuracy REAL,
  activity_type VARCHAR(50),
  place_name VARCHAR(255),
  place_category VARCHAR(100)
);

CREATE INDEX idx_location_coordinates ON location_history USING GIST(coordinates);
```

---

## Place Recognition

**Automatic Place Detection:**
1. GPS coordinates logged via iOS app or API
2. Server checks if within 100m of known place
3. If new area, queries Google Maps Places API
4. Enriches with place name, category, address
5. Assigns custom labels (Home, Work, Gym) based on visit patterns

**Place Categories:**
- Home (detected via frequent evening/morning visits)
- Work (detected via weekday daytime patterns)
- Gym (exercise activity + recurring visits)
- Restaurant, Store, Park (from Google Maps)
- Custom user-defined labels

---

## Testing

### Local Testing
```bash
# Build and test
npm run build
npm start

# Development mode with auto-reload
npm run dev

# Test with MCP Inspector
npm run inspector

# Test PostGIS queries
DATABASE_URL='<url>' npx tsx -e "
import pg from 'pg';
const pool = new pg.Pool({connectionString: process.env.DATABASE_URL});
const result = await pool.query('SELECT ST_AsText(coordinates) FROM location_history LIMIT 1');
console.log(result.rows);
"
```

### Verify Deployment
```bash
# Test OAuth metadata endpoints
curl https://location-history-mcp-server-835031330028.us-central1.run.app/.well-known/oauth-protected-resource/sse

# Test health endpoint
curl https://location-history-mcp-server-835031330028.us-central1.run.app/health

# Test unauthorized access (should return 401)
curl -i https://location-history-mcp-server-835031330028.us-central1.run.app/sse

# View logs
gcloud logging read "resource.type=cloud_run_revision AND resource.labels.service_name=location-history-mcp-server" \
  --limit 50 --format json
```

---

## Privacy Considerations

**Location Data Sensitivity:**
- GPS coordinates reveal home address, work location, travel patterns
- Server implements privacy zones (configurable radius around home)
- Data retention policy: 90 days by default, configurable per user
- Users can delete all location history via API

**Security Measures:**
- OAuth 2.1 authentication required for all access
- Per-user data isolation (queries filtered by user_id)
- Encrypted storage in PostgreSQL
- No location data shared between users

---

## Troubleshooting

### Common Issues

**PostGIS Errors:**
```bash
# Verify PostGIS extension is installed
DATABASE_URL='<url>' psql -c "SELECT PostGIS_Version();"

# Check spatial indexes
DATABASE_URL='<url>' psql -c "\d location_history"

# Test geography calculations
DATABASE_URL='<url>' psql -c "SELECT ST_Distance(ST_MakePoint(-122.4194, 37.7749)::geography, ST_MakePoint(-122.4183, 37.7758)::geography);"
```

**Google Maps API Errors:**
```bash
# Check API key in Secret Manager
gcloud secrets versions access latest --secret="google-maps-api-key"

# Test Places API directly
curl "https://maps.googleapis.com/maps/api/place/nearbysearch/json?location=37.7749,-122.4194&radius=100&key=<api-key>"
```

**OAuth Errors:**
```bash
# Standard troubleshooting (see whoop-mcp-server CLAUDE.md)
curl https://location-history-mcp-server-*.run.app/.well-known/oauth-protected-resource/sse
```

**Build Errors:**
```bash
# Clean rebuild
rm -rf build/ node_modules/
npm install
npm run build
```

### Debug Commands

```bash
# Check service status
gcloud run services describe location-history-mcp-server --region us-central1

# View real-time logs
gcloud logging tail "resource.type=cloud_run_revision AND resource.labels.service_name=location-history-mcp-server"

# Query recent locations
DATABASE_URL='<url>' npx tsx -e "
import pg from 'pg';
const pool = new pg.Pool({connectionString: process.env.DATABASE_URL});
const result = await pool.query('SELECT timestamp, ST_AsText(coordinates), place_name FROM location_history ORDER BY timestamp DESC LIMIT 10');
console.table(result.rows);
"
```

---

## Integration with iOS App

The iOS app (food-tracker-ios) logs location updates:

**Background Tracking:**
- Significant location changes (iOS Core Location)
- Geofence enter/exit events
- Manual check-ins from app

**Data Flow:**
1. iOS app detects location change
2. Sends GPS coordinates to backend API
3. Backend forwards to location-history-mcp-server
4. Server enriches with place data
5. Stores in PostGIS database
6. Available via MCP tools for Claude queries

---

## Notes

- **Always build before deploying** - Run `npm run build` to verify TypeScript compiles
- **PostGIS required** - Database must have PostGIS extension enabled
- **Privacy-first** - Location data is highly sensitive, handle with care
- **Timezone detection** - Uses geo-tz to determine timezone from coordinates
- **Google Maps quota** - Monitor API usage to avoid quota limits
- **Activity detection** - iOS app provides activity type (stationary, walking, driving)

---

**Production URL:** `https://location-history-mcp-server-835031330028.us-central1.run.app/sse`

**Last Updated:** 2025-11-22
**Service Owner:** LifeOS Platform Team
**Related Docs:** See `/docs/CLAUDE_MCP_INTEGRATION.md`, `/MCP_BEST_PRACTICES.md`
