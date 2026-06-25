/** Shared initials-avatar helpers for leads (table rows, kanban cards, dashboard panels). */

const AVATAR_COLORS = [
  "#2383E2",
  "#9065B0",
  "#C14C8A",
  "#448361",
  "#D9730D",
  "#337EA4",
  "#CB912F",
  "#C4554D",
];

export function initialsOf(name: string): string {
  return name
    .split(" ")
    .map((w) => w[0])
    .slice(0, 2)
    .join("")
    .toUpperCase();
}

export function colorFor(name: string): string {
  return AVATAR_COLORS[name.charCodeAt(0) % AVATAR_COLORS.length];
}
