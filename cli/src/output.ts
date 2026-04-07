const RED = "\x1b[0;31m";
const GREEN = "\x1b[0;32m";
const YELLOW = "\x1b[0;33m";
const BLUE = "\x1b[0;34m";
const CYAN = "\x1b[0;36m";
const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const NC = "\x1b[0m";

export function info(msg: string): void {
  console.log(`${BLUE}\u25b8${NC} ${msg}`);
}

export function success(msg: string): void {
  console.log(`${GREEN}\u2713${NC} ${msg}`);
}

export function warn(msg: string): void {
  console.log(`${YELLOW}\u26a0${NC} ${msg}`);
}

export function error(msg: string): void {
  console.error(`${RED}\u2717${NC} ${msg}`);
  process.exit(1);
}

export function header(title: string): void {
  console.log(`\n${BOLD}${CYAN}${title}${NC}\n`);
}

export function bold(text: string): string {
  return `${BOLD}${text}${NC}`;
}

export function dim(text: string): string {
  return `${DIM}${text}${NC}`;
}

export function cyan(text: string): string {
  return `${CYAN}${text}${NC}`;
}

export function yellow(text: string): string {
  return `${YELLOW}${text}${NC}`;
}

export function green(text: string): string {
  return `${GREEN}${text}${NC}`;
}

export function red(text: string): string {
  return `${RED}${text}${NC}`;
}
