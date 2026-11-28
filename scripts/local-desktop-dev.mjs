process.argv.splice(2, 0, "--dev");
await import("./mygo-desktop.mjs");
