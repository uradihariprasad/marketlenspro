import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "F&O Intraday Intelligence",
    short_name: "F&O Intel",
    description: "REST-polled F&O market intelligence, dynamic S/R, option positioning and disciplined trade candidates.",
    start_url: "/",
    display: "standalone",
    background_color: "#05070b",
    theme_color: "#05070b",
    orientation: "any",
    categories: ["finance", "business", "productivity"],
  };
}
