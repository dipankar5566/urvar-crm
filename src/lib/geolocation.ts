/**
 * Promise wrapper around the browser Geolocation API.
 *
 * Same options the customer location dialog has always used: a high-accuracy
 * fix, a 15s ceiling, and maximumAge 0 so a rep standing at a shop never gets
 * handed a cached fix from wherever they were earlier in the day — which for
 * a check-in would be exactly the wrong answer.
 */
export type Fix = {
  latitude: number;
  longitude: number;
  accuracy: number | null;
};

export class GeolocationUnavailable extends Error {}

export function getCurrentPosition(): Promise<Fix> {
  return new Promise((resolve, reject) => {
    if (typeof navigator === "undefined" || !navigator.geolocation) {
      reject(new GeolocationUnavailable("This device can't report a location."));
      return;
    }

    navigator.geolocation.getCurrentPosition(
      (position) =>
        resolve({
          latitude: position.coords.latitude,
          longitude: position.coords.longitude,
          accuracy: position.coords.accuracy ?? null,
        }),
      (err) =>
        reject(
          new GeolocationUnavailable(
            err.code === err.PERMISSION_DENIED
              ? "Location permission was denied. Allow it in your browser to check in."
              : "Couldn't get your location. Move somewhere with a clearer signal and try again.",
          ),
        ),
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 },
    );
  });
}
