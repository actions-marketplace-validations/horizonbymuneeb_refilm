// refilm — the data contract shared by every command.
// Anything written to disk and anything printed with --json uses these shapes.
// Changing a field here is a breaking change: bump the schema version.
export const SCHEMA = 1;
