import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MantineProvider, useMantineTheme, createTheme } from "@mantine/core";
import { register } from "node:module";
import { teamOwnerOptions } from "../src/features/customers/team-owner-options";
import type { AdminUserRecordDto } from "@chordv/shared";
register(new URL("./css-module-loader.mjs", import.meta.url));
const { AdminAppearance } = await import("../src/features/shared/AdminAppearance");
let observed: any;
function Inspect() { observed = useMantineTheme(); return null; }
function render(enabled: boolean) {
  renderToStaticMarkup(createElement(MantineProvider, { theme: createTheme({ primaryColor: "blue", defaultRadius: "lg" }) },
    createElement(AdminAppearance, { enabled, children: createElement(Inspect) })));
  return observed;
}
const modern = render(true);
assert.equal(modern.primaryColor, "teal");
assert.equal(modern.components.Select.defaultProps.maxDropdownHeight, 240);
assert.ok(modern.components.Combobox.classNames.dropdown);
const tickets = render(false);
assert.equal(tickets.primaryColor, "blue");
assert.equal(tickets.defaultRadius, "lg");
assert.equal(tickets.components.Combobox?.classNames?.dropdown, undefined);
const users = [
  { id: "owner", teamId: "a", status: "active" },
  { id: "member", teamId: "a", status: "active" },
  { id: "disabled", teamId: "a", status: "disabled" },
  { id: "other", teamId: "b", status: "active" },
  { id: "new", teamId: null, status: "active" }
].map(user=>({ ...user, role: "user", email: "test@example.invalid", displayName: user.id })) as AdminUserRecordDto[];
assert.deepEqual(teamOwnerOptions(users, "a").map(item=>item.value), ["owner", "member"]);
assert.deepEqual(teamOwnerOptions(users, null).map(item=>item.value), ["new"]);
assert.equal(teamOwnerOptions(users, "a", "disabled").find(item=>item.value==="disabled")?.disabled, true);
console.log("admin appearance ticket isolation and team owner options checks passed");
