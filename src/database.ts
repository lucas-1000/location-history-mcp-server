import pg from 'pg';
import { LocationPoint, Place, PlaceVisit, TravelStats } from './types.js';

export class Database {
  private pool: pg.Pool;

  constructor(connectionString: string) {
    const isCloudSQLSocket = connectionString.includes('/cloudsql/');

    this.pool = new pg.Pool({
      connectionString,
      ssl:
        !isCloudSQLSocket && process.env.NODE_ENV === 'production'
          ? { rejectUnauthorized: false }
          : false,
    });
  }

  /**
   * Initialize database schema with PostGIS support
   */
  async initialize(): Promise<void> {
    const client = await this.pool.connect();
    try {
      // Enable PostGIS extension
      await client.query(`CREATE EXTENSION IF NOT EXISTS postgis;`);

      // Location points table
      await client.query(`
        CREATE TABLE IF NOT EXISTS location_points (
          id SERIAL PRIMARY KEY,
          user_id VARCHAR(255) NOT NULL,
          latitude NUMERIC(10, 7) NOT NULL,
          longitude NUMERIC(10, 7) NOT NULL,
          accuracy NUMERIC(6, 2),
          altitude NUMERIC(8, 2),
          altitude_accuracy NUMERIC(6, 2),
          speed NUMERIC(6, 2),
          course NUMERIC(5, 2),
          timestamp TIMESTAMPTZ NOT NULL,
          local_timezone VARCHAR(50),
          device_model VARCHAR(255),
          device_os VARCHAR(255),
          app_version VARCHAR(50),
          place_id INTEGER,
          created_at TIMESTAMPTZ DEFAULT NOW(),
          geom GEOGRAPHY(Point, 4326),
          UNIQUE(user_id, timestamp, latitude, longitude)
        );

        -- Migration: Add local_timezone column if it doesn't exist
        ALTER TABLE location_points ADD COLUMN IF NOT EXISTS local_timezone VARCHAR(50);

        CREATE INDEX IF NOT EXISTS idx_location_user_time
          ON location_points(user_id, timestamp DESC);
        CREATE INDEX IF NOT EXISTS idx_location_timestamp
          ON location_points(timestamp DESC);
        CREATE INDEX IF NOT EXISTS idx_location_geom
          ON location_points USING GIST(geom);
        CREATE INDEX IF NOT EXISTS idx_location_place_id
          ON location_points(place_id);
      `);

      // Places table
      await client.query(`
        CREATE TABLE IF NOT EXISTS places (
          id SERIAL PRIMARY KEY,
          user_id VARCHAR(255) NOT NULL,
          name VARCHAR(255),
          category VARCHAR(100),
          center_lat NUMERIC(10, 7) NOT NULL,
          center_lng NUMERIC(10, 7) NOT NULL,
          radius NUMERIC(6, 2) NOT NULL DEFAULT 50,
          address TEXT,
          google_place_id VARCHAR(255),
          google_place_name VARCHAR(255),
          google_place_types TEXT[],
          visit_count INTEGER DEFAULT 0,
          created_at TIMESTAMPTZ DEFAULT NOW(),
          updated_at TIMESTAMPTZ DEFAULT NOW(),
          geom GEOGRAPHY(Point, 4326),
          UNIQUE(user_id, google_place_id)
        );

        CREATE INDEX IF NOT EXISTS idx_places_user
          ON places(user_id);
        CREATE INDEX IF NOT EXISTS idx_places_geom
          ON places USING GIST(geom);
        CREATE INDEX IF NOT EXISTS idx_places_name
          ON places(user_id, name);
      `);

      // Place visits table
      await client.query(`
        CREATE TABLE IF NOT EXISTS place_visits (
          id SERIAL PRIMARY KEY,
          user_id VARCHAR(255) NOT NULL,
          place_id INTEGER REFERENCES places(id) ON DELETE CASCADE,
          arrival_time TIMESTAMPTZ NOT NULL,
          departure_time TIMESTAMPTZ,
          duration_minutes INTEGER,
          created_at TIMESTAMPTZ DEFAULT NOW(),
          UNIQUE(user_id, place_id, arrival_time)
        );

        CREATE INDEX IF NOT EXISTS idx_visits_user_time
          ON place_visits(user_id, arrival_time DESC);
        CREATE INDEX IF NOT EXISTS idx_visits_place
          ON place_visits(place_id);
      `);

      console.log('✅ Database schema initialized with PostGIS');
    } finally {
      client.release();
    }
  }

  /**
   * Store location points (bulk insert)
   */
  async storeLocations(locations: LocationPoint[]): Promise<number> {
    if (locations.length === 0) return 0;

    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      let insertedCount = 0;
      for (const loc of locations) {
        const result = await client.query(
          `
          INSERT INTO location_points (
            user_id, latitude, longitude, accuracy, altitude,
            altitude_accuracy, speed, course, timestamp, local_timezone,
            device_model, device_os, app_version, geom
          )
          VALUES ($1, $2::numeric, $3::numeric, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, ST_SetSRID(ST_MakePoint(CAST($3 AS double precision), CAST($2 AS double precision)), 4326)::geography)
          ON CONFLICT (user_id, timestamp, latitude, longitude) DO NOTHING
          RETURNING id
          `,
          [
            loc.user_id,
            loc.latitude,
            loc.longitude,
            loc.accuracy || null,
            loc.altitude || null,
            loc.altitude_accuracy || null,
            loc.speed || null,
            loc.course || null,
            loc.timestamp,
            loc.local_timezone || null,
            loc.device_model || null,
            loc.device_os || null,
            loc.app_version || null,
          ]
        );
        if (result.rowCount && result.rowCount > 0) insertedCount++;
      }

      await client.query('COMMIT');
      return insertedCount;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Get location history for date range
   */
  async getLocationHistory(
    userId: string,
    startDate: Date,
    endDate: Date,
    limit: number = 1000
  ): Promise<LocationPoint[]> {
    const result = await this.pool.query(
      `
      SELECT * FROM location_points
      WHERE user_id = $1
        AND timestamp >= $2
        AND timestamp <= $3
      ORDER BY timestamp DESC
      LIMIT $4
      `,
      [userId, startDate, endDate, limit]
    );

    return result.rows;
  }

  /**
   * Get latest location
   */
  async getLatestLocation(userId: string): Promise<LocationPoint | null> {
    const result = await this.pool.query(
      `
      SELECT * FROM location_points
      WHERE user_id = $1
      ORDER BY timestamp DESC
      LIMIT 1
      `,
      [userId]
    );

    return result.rows[0] || null;
  }

  /**
   * Get location at specific time (closest match within 10 minutes)
   */
  async getLocationAtTime(userId: string, timestamp: Date): Promise<LocationPoint | null> {
    const result = await this.pool.query(
      `
      SELECT * FROM location_points
      WHERE user_id = $1
        AND ABS(EXTRACT(EPOCH FROM (timestamp - $2))) <= 600
      ORDER BY ABS(EXTRACT(EPOCH FROM (timestamp - $2)))
      LIMIT 1
      `,
      [userId, timestamp]
    );

    return result.rows[0] || null;
  }

  /**
   * Find locations near coordinates (within radius in meters)
   */
  async getLocationsNear(
    userId: string,
    lat: number,
    lng: number,
    radiusMeters: number,
    startDate?: Date,
    endDate?: Date,
    limit: number = 100
  ): Promise<LocationPoint[]> {
    const conditions = ['user_id = $1'];
    const values: any[] = [userId, lng, lat, radiusMeters];
    let paramIndex = 5;

    if (startDate) {
      conditions.push(`timestamp >= $${paramIndex}`);
      values.push(startDate);
      paramIndex++;
    }

    if (endDate) {
      conditions.push(`timestamp <= $${paramIndex}`);
      values.push(endDate);
      paramIndex++;
    }

    const result = await this.pool.query(
      `
      SELECT *,
        ST_Distance(geom, ST_SetSRID(ST_MakePoint($2, $3), 4326)::geography) as distance_meters
      FROM location_points
      WHERE ${conditions.join(' AND ')}
        AND ST_DWithin(geom, ST_SetSRID(ST_MakePoint($2, $3), 4326)::geography, $4)
      ORDER BY distance_meters
      LIMIT ${limit}
      `,
      values
    );

    return result.rows;
  }

  /**
   * Create or update a place
   */
  async upsertPlace(place: Place): Promise<Place> {
    // Use separate parameters for geometry (double precision) and columns (numeric)
    // to avoid PostgreSQL type inference issues
    const result = await this.pool.query(
      `
      INSERT INTO places (
        user_id, name, category, center_lat, center_lng, radius,
        address, google_place_id, google_place_name, google_place_types,
        geom
      )
      VALUES ($1, $2, $3, $4::numeric, $5::numeric, $6, $7, $8, $9, $10, ST_SetSRID(ST_MakePoint($11, $12), 4326)::geography)
      ON CONFLICT (user_id, google_place_id)
      DO UPDATE SET
        name = COALESCE(EXCLUDED.name, places.name),
        category = COALESCE(EXCLUDED.category, places.category),
        address = COALESCE(EXCLUDED.address, places.address),
        google_place_name = COALESCE(EXCLUDED.google_place_name, places.google_place_name),
        updated_at = NOW()
      RETURNING *
      `,
      [
        place.user_id,
        place.name || null,
        place.category || null,
        place.center_lat,
        place.center_lng,
        place.radius,
        place.address || null,
        place.google_place_id || null,
        place.google_place_name || null,
        place.google_place_types || null,
        Number(place.center_lng),  // $11 for ST_MakePoint (lng first)
        Number(place.center_lat),  // $12 for ST_MakePoint (lat second)
      ]
    );

    return result.rows[0];
  }

  /**
   * Find place near coordinates
   */
  async findPlaceNear(
    userId: string,
    lat: number,
    lng: number,
    maxDistanceMeters: number = 100
  ): Promise<Place | null> {
    const result = await this.pool.query(
      `
      SELECT *,
        ST_Distance(geom, ST_SetSRID(ST_MakePoint($3, $2), 4326)::geography) as distance_meters
      FROM places
      WHERE user_id = $1
        AND ST_DWithin(geom, ST_SetSRID(ST_MakePoint($3, $2), 4326)::geography, $4)
      ORDER BY distance_meters
      LIMIT 1
      `,
      [userId, lat, lng, maxDistanceMeters]
    );

    return result.rows[0] || null;
  }

  /**
   * Get all places for user
   */
  async getAllPlaces(userId: string): Promise<Place[]> {
    const result = await this.pool.query(
      `
      SELECT * FROM places
      WHERE user_id = $1
      ORDER BY visit_count DESC, name
      `,
      [userId]
    );

    return result.rows;
  }

  /**
   * Label a place (manual naming)
   */
  async labelPlace(
    userId: string,
    placeId: number,
    name: string,
    category?: string
  ): Promise<Place | null> {
    const result = await this.pool.query(
      `
      UPDATE places
      SET name = $3, category = $4, updated_at = NOW()
      WHERE id = $1 AND user_id = $2
      RETURNING *
      `,
      [placeId, userId, name, category || null]
    );

    return result.rows[0] || null;
  }

  /**
   * Record place visit
   */
  async recordPlaceVisit(visit: PlaceVisit): Promise<PlaceVisit> {
    const result = await this.pool.query(
      `
      INSERT INTO place_visits (user_id, place_id, arrival_time, departure_time, duration_minutes)
      VALUES ($1, $2, $3, $4, $5)
      ON CONFLICT (user_id, place_id, arrival_time)
      DO UPDATE SET
        departure_time = EXCLUDED.departure_time,
        duration_minutes = EXCLUDED.duration_minutes
      RETURNING *
      `,
      [
        visit.user_id,
        visit.place_id,
        visit.arrival_time,
        visit.departure_time || null,
        visit.duration_minutes || null,
      ]
    );

    // Increment visit count for place
    await this.pool.query(
      `
      UPDATE places
      SET visit_count = visit_count + 1
      WHERE id = $1
      `,
      [visit.place_id]
    );

    return result.rows[0];
  }

  /**
   * Get place visits for date range
   */
  async getPlaceVisits(
    userId: string,
    startDate?: Date,
    endDate?: Date,
    placeId?: number
  ): Promise<PlaceVisit[]> {
    const conditions = ['pv.user_id = $1'];
    const values: any[] = [userId];
    let paramIndex = 2;

    if (startDate) {
      conditions.push(`pv.arrival_time >= $${paramIndex}`);
      values.push(startDate);
      paramIndex++;
    }

    if (endDate) {
      conditions.push(`pv.arrival_time <= $${paramIndex}`);
      values.push(endDate);
      paramIndex++;
    }

    if (placeId) {
      conditions.push(`pv.place_id = $${paramIndex}`);
      values.push(placeId);
      paramIndex++;
    }

    const result = await this.pool.query(
      `
      SELECT
        pv.*,
        json_build_object(
          'id', p.id,
          'name', p.name,
          'category', p.category,
          'center_lat', p.center_lat,
          'center_lng', p.center_lng,
          'address', p.address
        ) as place
      FROM place_visits pv
      JOIN places p ON pv.place_id = p.id
      WHERE ${conditions.join(' AND ')}
      ORDER BY pv.arrival_time DESC
      `,
      values
    );

    return result.rows;
  }

  /**
   * Get travel statistics for date range
   */
  async getTravelStats(userId: string, startDate: Date, endDate: Date): Promise<TravelStats> {
    // Calculate total distance using PostGIS
    const distanceResult = await this.pool.query(
      `
      WITH ordered_points AS (
        SELECT
          latitude, longitude, timestamp, speed,
          LAG(latitude) OVER (ORDER BY timestamp) as prev_lat,
          LAG(longitude) OVER (ORDER BY timestamp) as prev_lng,
          LAG(timestamp) OVER (ORDER BY timestamp) as prev_time
        FROM location_points
        WHERE user_id = $1
          AND timestamp >= $2
          AND timestamp <= $3
        ORDER BY timestamp
      )
      SELECT
        COALESCE(SUM(
          ST_Distance(
            ST_SetSRID(ST_MakePoint(longitude, latitude), 4326)::geography,
            ST_SetSRID(ST_MakePoint(prev_lng, prev_lat), 4326)::geography
          )
        ), 0) as total_distance,
        COUNT(*) as point_count,
        MAX(speed) as max_speed,
        AVG(CASE WHEN speed > 0.5 THEN speed ELSE NULL END) as avg_speed_moving
      FROM ordered_points
      WHERE prev_lat IS NOT NULL
      `,
      [userId, startDate, endDate]
    );

    const stats = distanceResult.rows[0];
    const durationMinutes = (endDate.getTime() - startDate.getTime()) / 1000 / 60;

    return {
      total_distance_meters: parseFloat(stats.total_distance || '0'),
      total_duration_minutes: durationMinutes,
      moving_time_minutes: 0, // TODO: Calculate based on speed threshold
      stationary_time_minutes: 0,
      average_speed_mps: parseFloat(stats.avg_speed_moving || '0'),
      max_speed_mps: parseFloat(stats.max_speed || '0'),
      date_range: {
        start: startDate,
        end: endDate,
      },
    };
  }

  /**
   * Get unprocessed locations (no place_id assigned)
   */
  async getUnprocessedLocations(userId: string, limit: number = 1000): Promise<LocationPoint[]> {
    const result = await this.pool.query(
      `
      SELECT * FROM location_points
      WHERE user_id = $1
        AND place_id IS NULL
      ORDER BY timestamp ASC
      LIMIT $2
      `,
      [userId, limit]
    );

    return result.rows;
  }

  /**
   * Update location point with place_id
   */
  async updateLocationPlace(locationId: number, placeId: number): Promise<void> {
    await this.pool.query(
      `
      UPDATE location_points
      SET place_id = $2
      WHERE id = $1
      `,
      [locationId, placeId]
    );
  }

  /**
   * Execute a raw SQL query (for migrations and admin tasks)
   */
  async query(text: string, params?: any[]): Promise<any> {
    return this.pool.query(text, params);
  }

  /**
   * Look up user email by API key
   * API keys start with 'lifeos_' prefix
   */
  async getUserEmailByApiKey(apiKey: string): Promise<string | null> {
    if (!apiKey || !apiKey.startsWith('lifeos_')) {
      return null;
    }

    const result = await this.pool.query(
      'SELECT email FROM users WHERE api_key = $1',
      [apiKey]
    );

    if (result.rows.length === 0) {
      return null;
    }

    return result.rows[0].email;
  }

  /**
   * Close database connection
   */
  async close(): Promise<void> {
    await this.pool.end();
  }
}
