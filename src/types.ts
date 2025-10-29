/**
 * Type definitions for location tracking system
 */

export interface LocationPoint {
  id?: number;
  user_id: string;
  latitude: number;
  longitude: number;
  accuracy?: number;
  altitude?: number;
  altitude_accuracy?: number;
  speed?: number;
  course?: number;
  timestamp: Date;
  device_model?: string;
  device_os?: string;
  app_version?: string;
  place_id?: number;
  created_at?: Date;
}

export interface Place {
  id?: number;
  user_id: string;
  name?: string;
  category?: string;
  center_lat: number;
  center_lng: number;
  radius: number; // meters
  address?: string;
  google_place_id?: string;
  google_place_name?: string;
  google_place_types?: string[];
  visit_count?: number;
  created_at?: Date;
  updated_at?: Date;
}

export interface PlaceVisit {
  id?: number;
  user_id: string;
  place_id: number;
  place?: Place; // Joined data
  arrival_time: Date;
  departure_time?: Date;
  duration_minutes?: number;
  created_at?: Date;
}

export interface LocationCluster {
  center_lat: number;
  center_lng: number;
  points: LocationPoint[];
  start_time: Date;
  end_time: Date;
  duration_minutes: number;
}

export interface TravelStats {
  total_distance_meters: number;
  total_duration_minutes: number;
  moving_time_minutes: number;
  stationary_time_minutes: number;
  average_speed_mps: number;
  max_speed_mps: number;
  date_range: {
    start: Date;
    end: Date;
  };
}

export interface DailySummary {
  date: string;
  total_distance_meters: number;
  places_visited: number;
  time_moving_minutes: number;
  time_stationary_minutes: number;
  unique_places: Array<{
    name?: string;
    duration_minutes: number;
  }>;
}

// iOS upload payload
export interface LocationUploadPayload {
  locations: Array<{
    latitude: number;
    longitude: number;
    accuracy: number;
    altitude?: number;
    altitudeAccuracy?: number;
    speed?: number;
    course?: number;
    timestamp: string; // ISO format
  }>;
  device: {
    model: string;
    os: string;
    appVersion: string;
  };
}

// Google Places API response types
export interface GooglePlaceResult {
  place_id: string;
  name: string;
  formatted_address: string;
  types: string[];
  geometry: {
    location: {
      lat: number;
      lng: number;
    };
  };
}
