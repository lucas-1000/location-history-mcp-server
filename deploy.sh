#!/bin/bash

set -e

# Check for required environment variables
if [ -z "$GOOGLE_CLOUD_PROJECT" ]; then
  echo "❌ Error: GOOGLE_CLOUD_PROJECT environment variable not set"
  echo "Usage: GOOGLE_CLOUD_PROJECT=your-project-id ./deploy.sh"
  exit 1
fi

PROJECT_ID=$GOOGLE_CLOUD_PROJECT
SERVICE_NAME="location-history-mcp-server"
REGION="us-central1"

echo "🚀 Deploying Location History MCP Server to Cloud Run..."
echo "📦 Project: $PROJECT_ID"
echo "🌍 Region: $REGION"

# Build and push using Cloud Build
echo "🔨 Building container..."
gcloud builds submit --config cloudbuild.yaml --project=$PROJECT_ID

echo "✅ Deployment complete!"
echo ""
echo "📡 Service URL:"
gcloud run services describe $SERVICE_NAME --region=$REGION --project=$PROJECT_ID --format='value(status.url)'

echo ""
echo "🔧 Set environment variables (if not already set):"
echo "  DATABASE_URL - Your Cloud SQL connection string"
echo "  GOOGLE_PLACES_API_KEY - Your Google Places API key"
echo ""
echo "Run this command to set them:"
echo "  gcloud run services update $SERVICE_NAME --region=$REGION \\"
echo "    --set-env-vars DATABASE_URL=your-db-url,GOOGLE_PLACES_API_KEY=your-key"
