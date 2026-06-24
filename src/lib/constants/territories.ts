/**
 * Urvar operating territory. Pan-India expansion = append to this list (no DB
 * migration needed — state/district are plain string fields on Lead/Customer).
 */
export const TERRITORIES: Record<string, string[]> = {
  "West Bengal": ["Nadia", "Hooghly", "Bardhaman", "Murshidabad", "North 24 Parganas"],
  Maharashtra: ["Pune", "Nashik", "Kolhapur", "Nagpur", "Ahmednagar"],
  Karnataka: ["Belagavi", "Mysuru", "Shivamogga", "Dharwad", "Tumakuru"],
  "Uttar Pradesh": ["Meerut", "Lucknow", "Varanasi", "Agra", "Bareilly"],
};

export const STATES = Object.keys(TERRITORIES);

export function districtsForState(state: string): string[] {
  return TERRITORIES[state] ?? [];
}
