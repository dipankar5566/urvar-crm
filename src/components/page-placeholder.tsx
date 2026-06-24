import { Card, CardContent } from "@/components/ui/card";
import { Construction } from "lucide-react";

export function PagePlaceholder({
  title,
  description,
  sprint,
}: {
  title: string;
  description: string;
  sprint?: string;
}) {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
        <p className="text-sm text-muted-foreground">{description}</p>
      </div>
      <Card>
        <CardContent className="flex flex-col items-center justify-center gap-3 py-16 text-center">
          <Construction className="h-10 w-10 text-muted-foreground" />
          <p className="text-sm text-muted-foreground">
            This module is part of the build roadmap
            {sprint ? ` (${sprint})` : ""}.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
