import type { ComponentProps } from "react";
import type { ExpoRoot } from "expo-router";

type RouteContext = ComponentProps<typeof ExpoRoot>["context"];

export function nativeRouteContext(routes: RouteContext): RouteContext {
  function nativeRoutes<T>(id: string): T {
    return routes<T>(id);
  }
  nativeRoutes.keys = () =>
    routes
      .keys()
      .filter((key) =>
        /^\.\/(?:_layout|index|pisaas|\+not-found)(?:\.(?:android|ios|native))?\.[jt]sx?$/.test(
          key,
        ),
      );
  nativeRoutes.resolve = routes.resolve;
  nativeRoutes.id = routes.id;
  return nativeRoutes;
}
