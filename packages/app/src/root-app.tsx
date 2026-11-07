import { RenderProfile } from "@/utils/render-profiler";
import { useCallback, useMemo, useState, type ComponentProps } from "react";
import { ExpoRoot } from "expo-router";
import Head from "expo-router/head";
import { QueryClientProvider } from "@tanstack/react-query";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { queryClient } from "@/data/query-client";
import { I18nProvider } from "@/i18n/provider";
import { RootErrorBoundary } from "@/components/root-error-boundary";
import { isNative } from "@/constants/platform";
import { nativeRouteContext } from "@/navigation/native-route-context";

// Keep Expo's platform filtering, route root, and lazy import configuration.
const { ctx: context } = require("expo-router/_ctx") as {
  ctx: ComponentProps<typeof ExpoRoot>["context"];
};

export function RootApp() {
  return (
    <RenderProfile id="App">
      <RootRouter context={context} />
    </RenderProfile>
  );
}

export function RootRouter({ context: routes }: Pick<ComponentProps<typeof ExpoRoot>, "context">) {
  const [generation, setGeneration] = useState(0);
  const reload = useCallback(() => setGeneration((value) => value + 1), []);
  const recoveryLocation = isNative ? "/pisaas" : "/open-project";
  const activeRoutes = useMemo(() => (isNative ? nativeRouteContext(routes) : routes), [routes]);

  return (
    <QueryClientProvider client={queryClient}>
      <I18nProvider>
        <SafeAreaProvider>
          <RootErrorBoundary key={generation} onReload={reload}>
            <Head.Provider>
              {/* Recreate the router at a safe destination before a failed route can mount. */}
              <ExpoRoot
                context={activeRoutes}
                location={generation === 0 ? undefined : recoveryLocation}
              />
            </Head.Provider>
          </RootErrorBoundary>
        </SafeAreaProvider>
      </I18nProvider>
    </QueryClientProvider>
  );
}
