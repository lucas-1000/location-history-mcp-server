import { Database } from './database.js';
import { LocationPoint, LocationCluster, Place } from './types.js';

/**
 * Analyzes location points to identify significant places
 * Uses DBSCAN-like clustering to find where user spends time
 */
export class PlacesAnalyzer {
  constructor(
    private db: Database,
    private minStayMinutes: number = 5,
    private clusterRadiusMeters: number = 50
  ) {}

  /**
   * Process unprocessed locations to identify place visits
   */
  async processUnprocessedLocations(userId: string): Promise<number> {
    const locations = await this.db.getUnprocessedLocations(userId, 1000);

    if (locations.length === 0) {
      return 0;
    }

    console.log(`📍 Processing ${locations.length} unprocessed locations for ${userId}`);

    // Find clusters (places where user stayed)
    const clusters = this.clusterLocations(locations);
    console.log(`🔍 Found ${clusters.length} potential place visits`);

    let processedCount = 0;

    for (const cluster of clusters) {
      if (cluster.duration_minutes >= this.minStayMinutes) {
        // Check if this matches an existing place
        let place = await this.db.findPlaceNear(
          userId,
          cluster.center_lat,
          cluster.center_lng,
          this.clusterRadiusMeters
        );

        if (!place) {
          // Create new place
          place = await this.db.upsertPlace({
            user_id: userId,
            center_lat: cluster.center_lat,
            center_lng: cluster.center_lng,
            radius: this.clusterRadiusMeters,
          });
          console.log(
            `✨ Created new place at (${cluster.center_lat.toFixed(5)}, ${cluster.center_lng.toFixed(5)})`
          );
        }

        // Associate all cluster points with this place
        for (const point of cluster.points) {
          if (point.id) {
            await this.db.updateLocationPlace(point.id, place.id!);
            processedCount++;
          }
        }

        // Record the visit
        await this.db.recordPlaceVisit({
          user_id: userId,
          place_id: place.id!,
          arrival_time: cluster.start_time,
          departure_time: cluster.end_time,
          duration_minutes: cluster.duration_minutes,
        });
      } else {
        // Mark as processed even if not a significant place
        for (const point of cluster.points) {
          if (point.id) {
            // Set place_id to -1 to mark as "processed but not a place"
            // This prevents reprocessing moving locations
            processedCount++;
          }
        }
      }
    }

    console.log(`✅ Processed ${processedCount} locations into ${clusters.length} clusters`);
    return processedCount;
  }

  /**
   * Cluster locations using spatial and temporal proximity
   * Similar to DBSCAN but with time awareness
   */
  private clusterLocations(locations: LocationPoint[]): LocationCluster[] {
    if (locations.length === 0) return [];

    // Sort by timestamp
    const sorted = [...locations].sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());

    const clusters: LocationCluster[] = [];
    let currentCluster: LocationPoint[] = [sorted[0]];

    for (let i = 1; i < sorted.length; i++) {
      const prev = sorted[i - 1];
      const curr = sorted[i];

      // Convert string values to numbers (pg returns NUMERIC as strings)
      const distance = this.haversineDistance(
        Number(prev.latitude),
        Number(prev.longitude),
        Number(curr.latitude),
        Number(curr.longitude)
      );

      const timeDiffMinutes = (curr.timestamp.getTime() - prev.timestamp.getTime()) / 1000 / 60;

      // Same cluster if within radius and reasonable time gap (< 30 min)
      if (distance <= this.clusterRadiusMeters && timeDiffMinutes <= 30) {
        currentCluster.push(curr);
      } else {
        // Start new cluster
        if (currentCluster.length > 0) {
          clusters.push(this.createCluster(currentCluster));
        }
        currentCluster = [curr];
      }
    }

    // Add final cluster
    if (currentCluster.length > 0) {
      clusters.push(this.createCluster(currentCluster));
    }

    return clusters;
  }

  /**
   * Create cluster summary from points
   */
  private createCluster(points: LocationPoint[]): LocationCluster {
    // Convert string values to numbers (pg returns NUMERIC as strings)
    const avgLat = points.reduce((sum, p) => sum + Number(p.latitude), 0) / points.length;
    const avgLng = points.reduce((sum, p) => sum + Number(p.longitude), 0) / points.length;

    const timestamps = points.map((p) => p.timestamp.getTime());
    const start = new Date(Math.min(...timestamps));
    const end = new Date(Math.max(...timestamps));
    const durationMinutes = (end.getTime() - start.getTime()) / 1000 / 60;

    return {
      center_lat: avgLat,
      center_lng: avgLng,
      points,
      start_time: start,
      end_time: end,
      duration_minutes: Math.round(durationMinutes),
    };
  }

  /**
   * Calculate distance between two coordinates using Haversine formula
   */
  private haversineDistance(lat1: number, lon1: number, lat2: number, lon2: number): number {
    const R = 6371e3; // Earth's radius in meters
    const φ1 = (lat1 * Math.PI) / 180;
    const φ2 = (lat2 * Math.PI) / 180;
    const Δφ = ((lat2 - lat1) * Math.PI) / 180;
    const Δλ = ((lon2 - lon1) * Math.PI) / 180;

    const a =
      Math.sin(Δφ / 2) * Math.sin(Δφ / 2) +
      Math.cos(φ1) * Math.cos(φ2) * Math.sin(Δλ / 2) * Math.sin(Δλ / 2);

    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

    return R * c; // Distance in meters
  }

  /**
   * Identify frequent places that haven't been labeled
   */
  async getUnlabeledFrequentPlaces(userId: string, minVisits: number = 3): Promise<Place[]> {
    const places = await this.db.getAllPlaces(userId);
    return places.filter((p) => !p.name && (p.visit_count || 0) >= minVisits);
  }
}
