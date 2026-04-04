// Terminal colors and formatting utilities

const isColorEnabled = process.env.NO_COLOR === undefined && process.stdout.isTTY;

function color(code: string, text: string): string {
  if (!isColorEnabled) return text;
  return `${code}${text}\x1b[0m`;
}

export const colors = {
  red: (t: string) => color("\x1b[0;31m", t),
  green: (t: string) => color("\x1b[0;32m", t),
  yellow: (t: string) => color("\x1b[0;33m", t),
  blue: (t: string) => color("\x1b[0;34m", t),
  cyan: (t: string) => color("\x1b[0;36m", t),
  bold: (t: string) => color("\x1b[1m", t),
  dim: (t: string) => color("\x1b[2m", t),
};

export function info(message: string): void {
  console.log(`${colors.blue("▸")} ${message}`);
}

export function success(message: string): void {
  console.log(`${colors.green("✓")} ${message}`);
}

export function warn(message: string): void {
  console.log(`${colors.yellow("⚠")} ${message}`);
}

export function error(message: string): void {
  console.error(`${colors.red("✗")} ${message}`);
}

export function header(message: string): void {
  console.log(`\n${colors.bold(colors.cyan(message))}\n`);
}

/**
 * Print an OperationEvent to the terminal with appropriate formatting.
 */
export function printEvent(event: { type: string; message: string }): void {
  switch (event.type) {
    case "info":
      info(event.message);
      break;
    case "success":
      success(event.message);
      break;
    case "warn":
      warn(event.message);
      break;
    case "error":
      error(event.message);
      break;
    case "done":
      success(event.message);
      break;
    default:
      console.log(event.message);
  }
}

export function formatTable(
  headers: string[],
  rows: string[][],
  colWidths?: number[],
): void {
  const widths =
    colWidths ??
    headers.map((h, i) =>
      Math.max(h.length, ...rows.map((r) => (r[i] || "").length)),
    );

  const headerLine = headers
    .map((h, i) => colors.bold(h.padEnd(widths[i]!)))
    .join("  ");
  console.log(`  ${headerLine}`);

  for (const row of rows) {
    const line = row.map((c, i) => c.padEnd(widths[i]!)).join("  ");
    console.log(`  ${line}`);
  }
}
