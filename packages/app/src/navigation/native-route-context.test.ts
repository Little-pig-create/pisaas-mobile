import { expect, it, vi } from "vitest";
import { nativeRouteContext } from "./native-route-context";

it("registers only the native PiSaas route tree", () => {
  const keys = [
    "./_layout.tsx",
    "./index.tsx",
    "./pisaas.tsx",
    "./pisaas.android.tsx",
    "./+not-found.tsx",
    "./welcome.tsx",
    "./h/[serverId]/_layout.tsx",
    "./h/[serverId]/agent/[agentId].tsx",
    "./settings/index.tsx",
  ];
  const context = Object.assign(vi.fn(), { keys: () => keys, resolve: vi.fn(), id: "routes" });
  const native = nativeRouteContext(context);

  expect(native.keys()).toEqual(keys.slice(0, 5));
  expect(context.keys()).toEqual(keys);
  expect(native.resolve).toBe(context.resolve);
  expect(native.id).toBe(context.id);

  native("./pisaas.tsx");
  expect(context).toHaveBeenCalledWith("./pisaas.tsx");
});
