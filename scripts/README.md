# Migration Scripts

## Backfill Timezones

This script adds timezone information to existing location records by inferring the timezone from their coordinates.

### Running on Cloud Run (Recommended)

Since the database is only accessible from within Google Cloud, run this script from a Cloud Run job or instance:

```bash
# 1. Deploy the location-history-mcp-server to Cloud Run (it will create the column automatically)
gcloud run deploy location-history-mcp-server \
  --source . \
  --region=us-central1 \
  --project=personal-assistant-e4351

# 2. Run the migration script via Cloud Run exec
gcloud run services proxy location-history-mcp-server \
  --region=us-central1 \
  --project=personal-assistant-e4351 &

# Then in another terminal:
npm run migrate:timezones
```

### Running Locally (Requires Cloud SQL Proxy)

If you need to run locally, first start the Cloud SQL proxy:

```bash
# Start Cloud SQL Proxy
cloud_sql_proxy -instances=personal-assistant-e4351:us-central1:health-data-db=tcp:5432

# In another terminal, run the migration
DATABASE_URL="postgresql://postgres:PASSWORD@localhost:5432/health_data" \
  npx tsx scripts/backfill-timezones.ts
```

### What it does

1. Adds the `local_timezone` column if it doesn't exist
2. Fetches all location points without a timezone
3. Uses the `geo-tz` library to infer timezone from latitude/longitude
4. Updates each record with the inferred timezone
5. Processes in batches of 100 for efficiency

### Expected Output

```
🚀 Starting timezone backfill migration...

📝 Ensuring local_timezone column exists...
✅ Column check complete

📊 Found 1234 records without timezone
⏳ Processing in batches of 100...

📈 Progress: 100/1234 (8.1%) - Updated: 100, Errors: 0
📈 Progress: 200/1234 (16.2%) - Updated: 200, Errors: 0
...

✅ Migration complete!
📊 Final stats:
   - Total processed: 1234
   - Successfully updated: 1234
   - Errors: 0

🎉 Done!
```
