import { Client, PlaceInputType } from '@googlemaps/google-maps-services-js';
import { Place } from './types.js';

/**
 * Google Places API client for reverse geocoding
 */
export class GooglePlacesClient {
  private client: Client;
  private apiKey: string;

  constructor(apiKey: string) {
    this.client = new Client({});
    this.apiKey = apiKey;
  }

  /**
   * Reverse geocode coordinates to get place information
   */
  async reverseGeocode(
    lat: number,
    lng: number
  ): Promise<Partial<Place> | null> {
    try {
      const response = await this.client.reverseGeocode({
        params: {
          latlng: { lat, lng },
          key: this.apiKey,
        },
      });

      if (response.data.results.length === 0) {
        return null;
      }

      const result = response.data.results[0];

      return {
        google_place_id: result.place_id,
        google_place_name: result.formatted_address,
        address: result.formatted_address,
        google_place_types: result.types,
        center_lat: lat,
        center_lng: lng,
      };
    } catch (error) {
      console.error('❌ Google Places API error:', error);
      return null;
    }
  }

  /**
   * Get nearby places (businesses, points of interest)
   */
  async getNearbyPlaces(
    lat: number,
    lng: number,
    radiusMeters: number = 50
  ): Promise<Array<Partial<Place>>> {
    try {
      const response = await this.client.placesNearby({
        params: {
          location: { lat, lng },
          radius: radiusMeters,
          key: this.apiKey,
        },
      });

      return response.data.results.map((result) => ({
        google_place_id: result.place_id,
        google_place_name: result.name,
        address: result.vicinity,
        google_place_types: result.types,
        center_lat: result.geometry?.location.lat || lat,
        center_lng: result.geometry?.location.lng || lng,
      }));
    } catch (error) {
      console.error('❌ Google Places API error:', error);
      return [];
    }
  }

  /**
   * Get place details by place ID
   */
  async getPlaceDetails(placeId: string): Promise<Partial<Place> | null> {
    try {
      const response = await this.client.placeDetails({
        params: {
          place_id: placeId,
          key: this.apiKey,
        },
      });

      const result = response.data.result;

      return {
        google_place_id: result.place_id,
        google_place_name: result.name,
        address: result.formatted_address,
        google_place_types: result.types,
        center_lat: result.geometry?.location.lat || 0,
        center_lng: result.geometry?.location.lng || 0,
      };
    } catch (error) {
      console.error('❌ Google Places API error:', error);
      return null;
    }
  }

  /**
   * Infer place category from Google place types
   */
  inferCategory(types: string[]): string {
    const categoryMap: Record<string, string[]> = {
      home: ['home', 'premise', 'street_address'],
      work: ['office', 'establishment'],
      restaurant: [
        'restaurant',
        'food',
        'cafe',
        'bar',
        'bakery',
        'meal_takeaway',
        'meal_delivery',
      ],
      gym: ['gym', 'health', 'fitness'],
      store: [
        'store',
        'shopping_mall',
        'supermarket',
        'grocery_or_supermarket',
        'convenience_store',
      ],
      transit: [
        'transit_station',
        'train_station',
        'bus_station',
        'airport',
        'subway_station',
      ],
      entertainment: [
        'movie_theater',
        'museum',
        'amusement_park',
        'aquarium',
        'art_gallery',
        'bowling_alley',
        'casino',
        'night_club',
      ],
      education: ['school', 'university', 'library'],
      healthcare: ['hospital', 'doctor', 'dentist', 'pharmacy', 'health'],
      recreation: ['park', 'playground', 'stadium', 'campground'],
      lodging: ['lodging', 'hotel', 'motel'],
    };

    for (const [category, keywords] of Object.entries(categoryMap)) {
      if (types.some((type) => keywords.includes(type))) {
        return category;
      }
    }

    return 'other';
  }
}
