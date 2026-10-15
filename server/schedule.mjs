#!/usr/bin/env node
// Stage launchd plists for the scheduled syncs: sh run.sh schedule stage. (install/uninstall/status are in run.sh so root never runs node.)
import { writeFileSync, mkdirSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir, userInfo } from "node:os";
export const JOBS = {
  payments: { label: "com.trolley-plugin.payment-sync", log: "payment-sync", cal: [{ Minute: 7 }] },             // hourly at :07
  recipients: { label: "com.trolley-plugin.recipient-sync", log: "recipient-sync", cal: [0, 6, 12, 18].map(Hour => ({ Hour, Minute: 37 })) }, // 00:37 06:37 12:37 18:37 local
  monitor: { label: "com.trolley-plugin.payday-monitor", log: "payday-monitor", cal: [0, 15, 30, 45].map(Minute => ({ Minute })), agentOnly: true, args: ["monitor", "run"] }, // every 15 min; exits unless payday
};
const x = s => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const dict = o => `<dict>${Object.entries(o).map(([k, v]) => `<key>${x(k)}</key><integer>${v}</integer>`).join("")}</dict>`;
export function plist(job, { plugin, home = homedir(), user = userInfo().username, daemon = true } = {}) {
  const j = JOBS[job], logs = join(home, "Library", "Logs", "trolley-plugin");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${x(j.label)}</string>
${daemon ? `  <key>UserName</key><string>${x(user)}</string>\n` : ""}  <key>ProgramArguments</key>
  <array><string>/bin/sh</string><string>${x(join(plugin, "run.sh"))}</string>${(j.args ?? ["sync", job]).map(a => `<string>${x(a)}</string>`).join("")}</array>
  <key>EnvironmentVariables</key>
  <dict><key>HOME</key><string>${x(home)}</string><key>PATH</key><string>/usr/bin:/bin:/usr/sbin:/sbin</string></dict>
  <key>WorkingDirectory</key><string>${x(plugin)}</string>
  <key>StartCalendarInterval</key>
  <array>${j.cal.map(dict).join("")}</array>
  <key>RunAtLoad</key><false/>
  <key>ProcessType</key><string>Background</string>
  <key>LowPriorityIO</key><true/>
  <key>Umask</key><integer>63</integer>
  <key>StandardOutPath</key><string>${x(join(logs, j.log + ".launchd.log"))}</string>
  <key>StandardErrorPath</key><string>${x(join(logs, j.log + ".launchd.log"))}</string>
</dict>
</plist>
`;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const plugin = resolve(dirname(fileURLToPath(import.meta.url)), ".."), out = join(plugin, "launchd");
  mkdirSync(join(out, "daemon"), { recursive: true }); mkdirSync(join(out, "agent"), { recursive: true });
  mkdirSync(join(homedir(), "Library", "Logs", "trolley-plugin"), { recursive: true, mode: 0o700 });
  for (const job of Object.keys(JOBS)) for (const daemon of JOBS[job].agentOnly ? [false] : [true, false])
    writeFileSync(join(out, daemon ? "daemon" : "agent", JOBS[job].label + ".plist"), plist(job, { plugin, daemon }), { mode: 0o644 });
  process.stdout.write(out + "\n");
}
