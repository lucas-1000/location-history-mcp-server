/**
 * Migration script to backfill timezone data for existing location points
 *
 * This script:
 * 1. Fetches all location points without a timezone
 * 2. Infers the timezone from lat/long coordinates using geo-tz
 * 3. Updates the records with the inferred timezone
 *
 * Usage:
 *   npx tsx scripts/backfill-timezones.ts
 */

import { Pool } from 'pg';
import geoTz from 'geo-tz';

const DATABASE_URL = process.env.DATABASE_URL;

if (!DATABASE_URL) {
  console.error('❌ DATABASE_URL environment variable is required');
  process.exit(1);
}

const pool = new Pool({
  connectionString: DATABASE_URL,
});

async function backfillTimezones() {
  console.log('🚀 Starting timezone backfill migration...\n');

  try {
    // First, ensure the column exists
    console.log('📝 Ensuring local_timezone column exists...');
    await pool.query(`
      ALTER TABLE location_points
      ADD COLUMN IF NOT EXISTS local_timezone VARCHAR(50);
    `);
    console.log('✅ Column check complete\n');

    // Get count of records without timezone
    const countResult = await pool.query(`
      SELECT COUNT(*) as count
      FROM location_points
      WHERE local_timezone IS NULL
    `);
    const totalRecords = parseInt(countResult.rows[0].count);

    if (totalRecords === 0) {
      console.log('✅ No records need timezone backfill!');
      return;
    }

    console.log(`📊 Found ${totalRecords} records without timezone`);
    console.log('⏳ Processing in batches of 100...\n');

    let processedCount = 0;
    let updatedCount = 0;
    let errorCount = 0;
    let offset = 0;
    const batchSize = 100;

    while (offset < totalRecords) {
      // Fetch batch of records without timezone
      const result = await pool.query(`
        SELECT id, latitude, longitude
        FROM location_points
        WHERE local_timezone IS NULL
        ORDER BY id
        LIMIT $1 OFFSET $2
      `, [batchSize, offset]);

      const batch = result.rows;

      if (batch.length === 0) break;

      // Process each record in the batch
      for (const record of batch) {
        try {
          // Infer timezone from coordinates
          const timezones = geoTz.find(record.latitude, record.longitude);
          const timezone = timezones[0]; // Get first (most likely) timezone

          if (timezone) {
            // Update the record
            await pool.query(`
              UPDATE location_points
              SET local_timezone = $1
              WHERE id = $2
            `, [timezone, record.id]);

            updatedCount++;
          } else {
            console.warn(`⚠️  No timezone found for coordinates (${record.latitude}, ${record.longitude})`);
            errorCount++;
          }
        } catch (error) {
          console.error(`❌ Error processing record ${record.id}:`, error);
          errorCount++;
        }

        processedCount++;
      }

      // Log progress
      const progress = ((processedCount / totalRecords) * 100).toFixed(1);
      console.log(`📈 Progress: ${processedCount}/${totalRecords} (${progress}%) - Updated: ${updatedCount}, Errors: ${errorCount}`);

      offset += batchSize;
    }

    console.log('\n✅ Migration complete!');
    console.log(`📊 Final stats:`);
    console.log(`   - Total processed: ${processedCount}`);
    console.log(`   - Successfully updated: ${updatedCount}`);
    console.log(`   - Errors: ${errorCount}`);

  } catch (error) {
    console.error('❌ Migration failed:', error);
    throw error;
  } finally {
    await pool.end();
  }
}

// Run the migration
backfillTimezones()
  .then(() => {
    console.log('\n🎉 Done!');
    process.exit(0);
  })
  .catch((error) => {
    console.error('\n💥 Fatal error:', error);
    process.exit(1);
  });
