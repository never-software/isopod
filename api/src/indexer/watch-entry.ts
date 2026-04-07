#!/usr/bin/env node
// Entry point for the watcher daemon (spawned as a detached child process)
import { startWatcher } from "./watcher.js";

startWatcher();
