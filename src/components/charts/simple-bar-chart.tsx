"use client";

import {
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { inr } from "@/lib/constants/labels";

function formatNumber(value: number) {
  return value.toLocaleString("en-IN");
}

export function SimpleBarChart({
  data,
  dataKey,
  nameKey,
  color = "var(--chart-1)",
  format = "number",
}: {
  data: Record<string, unknown>[];
  dataKey: string;
  nameKey: string;
  color?: string;
  format?: "number" | "currency";
}) {
  if (data.length === 0) {
    return <p className="py-8 text-center text-sm text-muted-foreground">No data for this range.</p>;
  }

  const formatValue = format === "currency" ? inr : formatNumber;

  return (
    <ResponsiveContainer width="100%" height={260}>
      <BarChart data={data} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
        <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="var(--border)" />
        <XAxis dataKey={nameKey} fontSize={12} tickLine={false} tick={{ fill: "var(--muted-foreground)" }} />
        <YAxis fontSize={12} tickLine={false} tickFormatter={formatValue} tick={{ fill: "var(--muted-foreground)" }} />
        <Tooltip
          formatter={(value) => formatValue(Number(value))}
          contentStyle={{
            background: "var(--popover)",
            border: "1px solid var(--glass-border)",
            borderRadius: "var(--radius-md)",
            color: "var(--popover-foreground)",
          }}
        />
        <Bar dataKey={dataKey} fill={color} radius={[4, 4, 0, 0]} />
      </BarChart>
    </ResponsiveContainer>
  );
}
