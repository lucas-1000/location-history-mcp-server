# Location History MCP Server

A comprehensive Model Context Protocol (MCP) server for personal location tracking with intelligent place recognition, automatic clustering, and Google Places integration.

## Features

- **Real-time GPS Tracking**: Store location points from iOS app with high accuracy
- **Intelligent Place Detection**: Automatic clustering to identify where you spend time
- **Place Recognition**: Google Places API integration for automatic place naming
- **Manual Labeling**: Name your frequent places (Home, Work, Gym, etc.)
- **Visit Tracking**: Automatic detection of arrival/departure times
- **Travel Statistics**: Distance traveled, average speed, time spent moving
- **13 MCP Tools**: Comprehensive AI-accessible location queries
- **PostGIS Support**: Advanced geospatial queries and radius searches

## Architecture

```
iOS App → location-history-mcp-server → PostgreSQL (PostGIS)
                                            ↓
                                    ChatGPT / Claude
                                   (13 MCP tools)
```

## Available MCP Tools

### Location Queries
1. **`get_current_location`** - Your most recent GPS position
2. **`get_location_history`** - GPS points for date range
3. **`get_location_at_time`** - Where were you at [specific time]?
4. **`search_locations_near`** - Find visits near coordinates/address
5. **`get_travel_stats`** - Distance, speed, time traveled

### Place Management
6. **`get_frequent_places`** - Most visited places (sorted by visit count)
7. **`list_all_places`** - All identified places (labeled & unlabeled)
8. **`label_place`** - Name a place (e.g., "Home", "Equinox Gym")
9. **`get_unlabeled_frequent_places`** - Suggest places to label

### Place Queries
10. **`get_place_visits`** - All visits to a specific place
11. **`get_time_at_place`** - Total time spent at a place
12. **`enrich_place_with_google`** - Get business name from Google Places API
13. **`process_recent_locations`** - Trigger place detection/clustering

## Prerequisites

1. **PostgreSQL Database with PostGIS**
   - Cloud SQL instance or local PostgreSQL
   - PostGIS extension enabled
   - Same database as health-data-storage recommended

2. **Google Places API Key** (Optional but recommended)
   - Enable Places API in Google Cloud Console
   - For automatic place name resolution
   - Cost: ~$0.005 per API call

3. **iOS Location Tracker App**
   - See: `location-tracker-ios` (companion app)

## Setup

### 1. Install Dependencies

```bash
npm install
```

### 2. Configure Environment Variables

Create `.env` file:

```bash
# Database (use your health-data-storage Cloud SQL connection)
DATABASE_URL=postgresql://user:pass@/health_data?host=/cloudsql/PROJECT:REGION:INSTANCE

# Google Places API (optional)
GOOGLE_PLACES_API_KEY=your_api_key_here

# User ID (your email)
DEFAULT_USER_ID=lucashanson132@gmail.com
```

### 3. Initialize Database

The server automatically creates tables on first run:
- `location_points` - GPS coordinates with timestamps
- `places` - Identified significant places
- `place_visits` - Visit records with arrival/departure times

```bash
npm run dev
```

### 4. Deploy to Cloud Run

```bash
GOOGLE_CLOUD_PROJECT=your-project-id ./deploy.sh
```

## iOS App Configuration

Update `location-tracker-ios/LocationTracker/APIClient.swift`:

```swift
private let baseURL = "https://location-history-mcp-server-xxxxx.run.app"
```

Update `location-tracker-ios/LocationTracker/Config.swift`:

```swift
static let userId = "lucashanson132@gmail.com"
```

## Usage with ChatGPT

1. Go to ChatGPT Settings → GPT Connectors
2. Add server URL: `https://your-server.run.app/sse`
3. Start asking questions:

```
"Where was I last Tuesday at 3pm?"
"How much did I travel this week?"
"How many times did I visit the gym this month?"
"Show me my most frequent places"
"Label place #5 as 'Home'"
```

## Usage with Claude Desktop

Add to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "location-history": {
      "url": "https://your-server.run.app/sse"
    }
  }
}
```

## How Place Detection Works

1. **Upload**: iOS app uploads GPS points in batches of 10
2. **Storage**: Points stored in `location_points` table
3. **Clustering**: Background process identifies "stops" (stayed >5 min within 50m)
4. **Place Creation**: New place created or matched to existing place
5. **Visit Recording**: Arrival/departure times tracked in `place_visits`
6. **Google Enrichment** (optional): Reverse geocode to get business names
7. **Manual Labeling**: You name important places

## Database Schema

### location_points
```sql
- id, user_id, latitude, longitude
- accuracy, altitude, speed, course
- timestamp, device_model, device_os
- place_id (FK to places)
- geom (PostGIS geography point)
```

### places
```sql
- id, user_id, name, category
- center_lat, center_lng, radius
- address, google_place_id, google_place_name
- visit_count, created_at, updated_at
- geom (PostGIS geography point)
```

### place_visits
```sql
- id, user_id, place_id (FK)
- arrival_time, departure_time, duration_minutes
```

## API Endpoints

- **`POST /upload`** - iOS app uploads location batches
- **`GET /health`** - Health check
- **`GET /sse`** - MCP SSE transport
- **`POST /message`** - MCP message handler
- **`GET /tools`** - List available MCP tools

## Example Queries

### "Where was I yesterday at 2pm?"
```
Tool: get_location_at_time
Args: { timestamp: "2025-10-26T14:00:00Z" }
Returns: Lat/lng coordinates
```

### "How long did I spend at work this week?"
```
Tool: get_time_at_place
Args: {
  place_name: "Work",
  start_date: "2025-10-20T00:00:00Z",
  end_date: "2025-10-27T00:00:00Z"
}
Returns: Total hours, visit count, average visit duration
```

### "What are my most visited places?"
```
Tool: get_frequent_places
Returns: Sorted list with visit counts, coordinates, names
```

## Privacy & Security

- **Your Data**: All location data stays in your Cloud SQL database
- **No Third-party Storage**: MCP server doesn't store data, only queries it
- **Optional Google API**: Use only when you explicitly enrich a place
- **User Control**: You decide which places to label and share with AI

## Development

```bash
# Local development
npm run dev

# Build TypeScript
npm run build

# Run production
npm start
```

## Cost Considerations

- **Cloud Run**: Free tier covers typical personal use
- **Cloud SQL**: Shared with health-data-storage, no additional cost
- **Google Places API**: ~$0.005/call, only used for enrichment
- **Total**: Typically $0-3/month for personal use

## Troubleshooting

### No locations appearing
- Check iOS app is uploading: look for "✅ Successfully uploaded" logs
- Verify DATABASE_URL in Cloud Run environment variables
- Run health check: `curl https://your-server.run.app/health`

### Places not being detected
- Ensure you're staying in one location for 5+ minutes
- Manually trigger: use `process_recent_locations` tool
- Check clustering settings in `PlacesAnalyzer` constructor

### Google Places not working
- Verify GOOGLE_PLACES_API_KEY is set in Cloud Run
- Enable Places API in Google Cloud Console
- Check API quotas and billing

## Support

For issues:
1. Check Cloud Run logs: `gcloud run services logs read location-history-mcp-server`
2. Verify database connectivity
3. Check iOS app logs

## License

MIT License

---

Built with [Model Context Protocol](https://modelcontextprotocol.io/) and deployed on [Google Cloud Run](https://cloud.google.com/run)
