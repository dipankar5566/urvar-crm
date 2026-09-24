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
  color = "#16a34a",
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
        <CartesianGrid strokeDasharray="3 3" vertical={false} />
        <XAxis dataKey={nameKey} fontSize={12} tickLine={false} />
        <YAxis fontSize={12} tickLine={false} tickFormatter={formatValue} />
        <Tooltip formatter={(value) => formatValue(Number(value))} />
        <Bar dataKey={dataKey} fill={color} radius={[4, 4, 0, 0]} />
      </BarChart>
    </ResponsiveContainer>
  );
}
