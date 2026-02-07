#!/usr/bin/env node

/**
 * Upload SRT Captions to Cloudflare Stream
 *
 * Matches SRT files in the ./caption/ folder to migrated videos
 * using migration-results.json, then uploads each caption via the
 * Cloudflare Stream API.
 *
 * Usage:
 *   node upload-captions.js              # Upload all captions
 *   node upload-captions.js --dry-run    # Preview matches without uploading
 *   node upload-captions.js --lang=en    # Set language (default: )
 */

import "dotenv/config";
import { readFileSync, readdirSync, existsSync, appendFileSync, writeFileSync } from "fs";
import { join, basename } from "path";

// ─── Configuration ──────────────────────────────────────────────────────────────

const {
  CLOUDFLARE_API_TOKEN,
  CLOUDFLARE_ACCOUNT_ID,
  DELAY_MS = "2000",
} = process.env;

if (!CLOUDFLARE_API_TOKEN || !CLOUDFLARE_ACCOUNT_ID) {
  console.error("❌  Missing CLOUDFLARE_API_TOKEN or CLOUDFLARE_ACCOUNT_ID in .env");
  process.exit(1);
}

const RESULTS_FILE = "migration-results.json";
const CAPTIONS_DIR = "caption";
const LOG_FILE = "caption-upload.log";

// ─── CLI Flags ──────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const DRY_RUN = args.includes("--dry-run");
const langFlag = args.find((a) => a.startsWith("--lang="));
const LANGUAGE = langFlag ? langFlag.split("=")[1] : "he";

// ─── Helpers ────────────────────────────────────────────────────────────────────

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Append a line to the log file (plain text, no icons). */
function log(line) {
  appendFileSync(LOG_FILE, line + "\n");
}

/**
 * Normalize a name for fuzzy matching:
 * - Remove file extension (.mp4, .srt)
 * - Trim whitespace
 * - Collapse multiple spaces
 * - Remove trailing underscores and dots
 */
function normalize(name) {
  return name
    .replace(/\.(mp4|srt|MP4)$/i, "")
    .replace(/[_.]$/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Convert SRT content to WebVTT format (Cloudflare only accepts VTT).
 * - Adds the WEBVTT header
 * - Replaces comma with dot in timestamps (00:00:08,667 → 00:00:08.667)
 */
function srtToVtt(srtContent) {
  const vtt = srtContent
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, "$1.$2");
  return "WEBVTT\n\n" + vtt.trim() + "\n";
}

// ─── Load migration results ────────────────────────────────────────────────────

function loadMigrationResults() {
  if (!existsSync(RESULTS_FILE)) {
    console.error("❌  " + RESULTS_FILE + " not found. Run the video migration first (npm start).");
    process.exit(1);
  }
  const results = JSON.parse(readFileSync(RESULTS_FILE, "utf-8"));
  return results.filter((r) => r.success);
}

// ─── Load SRT files ─────────────────────────────────────────────────────────────

function loadSrtFiles() {
  if (!existsSync(CAPTIONS_DIR)) {
    console.error("❌  Caption folder not found: " + CAPTIONS_DIR + "/");
    console.error("   Create it and place your .srt files inside.");
    process.exit(1);
  }
  return readdirSync(CAPTIONS_DIR).filter((f) => f.toLowerCase().endsWith(".srt"));
}

// ─── Match SRT files to Cloudflare videos ───────────────────────────────────────

function matchCaptions(srtFiles, migrationResults) {
  const matched = [];
  const unmatched = [];

  // Build a lookup map: normalized video name -> migration result
  const nameToVideo = new Map();
  for (const result of migrationResults) {
    const key = normalize(result.name);
    if (!nameToVideo.has(key)) {
      nameToVideo.set(key, result);
    }
  }

  for (const srtFile of srtFiles) {
    const srtKey = normalize(srtFile);
    const video = nameToVideo.get(srtKey);

    if (video) {
      matched.push({
        srtFile,
        videoName: video.name,
        cloudflareUid: video.cloudflareUid,
        spotlightrId: video.spotlightrId,
      });
    } else {
      unmatched.push(srtFile);
    }
  }

  return { matched, unmatched };
}

// ─── Upload caption to Cloudflare ───────────────────────────────────────────────

async function uploadCaption(cloudflareUid, srtFilePath, language) {
  const url = "https://api.cloudflare.com/client/v4/accounts/" + CLOUDFLARE_ACCOUNT_ID + "/stream/" + cloudflareUid + "/captions/" + language;

  const srtContent = readFileSync(srtFilePath, "utf-8");
  const vttContent = srtToVtt(srtContent);
  const vttFilename = basename(srtFilePath).replace(/\.srt$/i, ".vtt");

  const formData = new FormData();
  formData.append("file", new Blob([vttContent], { type: "text/vtt" }), vttFilename);

  const response = await fetch(url, {
    method: "PUT",
    headers: {
      Authorization: "Bearer " + CLOUDFLARE_API_TOKEN,
    },
    body: formData,
  });

  const data = await response.json();
  return data;
}

// ─── Main ───────────────────────────────────────────────────────────────────────

async function main() {
  console.log("╔══════════════════════════════════════════════════════════╗");
  console.log("║   Cloudflare Stream — Caption Upload Tool              ║");
  console.log("╚══════════════════════════════════════════════════════════╝");
  console.log();

  // Initialise log file
  if (!DRY_RUN) {
    writeFileSync(LOG_FILE, "=== Caption Upload Log — " + new Date().toISOString() + " ===\n");
    log("Language: " + LANGUAGE);
    log("");
  }

  if (DRY_RUN) {
    console.log("🏃  DRY RUN MODE — no API calls will be made\n");
  }

  console.log("🌐  Language: " + LANGUAGE + "\n");

  // Load data
  const migrationResults = loadMigrationResults();
  console.log("📂  Loaded " + migrationResults.length + " migrated videos from " + RESULTS_FILE);

  const srtFiles = loadSrtFiles();
  console.log("📂  Found " + srtFiles.length + " SRT files in " + CAPTIONS_DIR + "/\n");

  // Match SRT files to videos
  const { matched, unmatched } = matchCaptions(srtFiles, migrationResults);

  console.log("✅  Matched: " + matched.length);
  console.log("❓  Unmatched: " + unmatched.length + "\n");

  if (unmatched.length > 0) {
    console.log("⚠️   Unmatched SRT files (no matching video found):");
    for (const f of unmatched) {
      console.log("     - " + f);
    }
    console.log("\n   Rename these files to match the video names in migration-results.json\n");
  }

  if (matched.length === 0) {
    console.log("Nothing to upload. Exiting.");
    return;
  }

  // Upload
  let successCount = 0;
  let failCount = 0;

  for (let i = 0; i < matched.length; i++) {
    const { srtFile, videoName, cloudflareUid } = matched[i];
    const progress = "[" + (i + 1) + "/" + matched.length + "]";

    if (DRY_RUN) {
      console.log(progress + " 🔍  Would upload: \"" + srtFile + "\"");
      console.log("         → Video: \"" + videoName + "\"");
      successCount++;
      continue;
    }

    try {
      console.log(progress + " 🚀  Uploading: \"" + srtFile + "\"");
      console.log("         → Video: \"" + videoName + "\" (" + cloudflareUid + ")");

      const srtPath = join(CAPTIONS_DIR, srtFile);
      const response = await uploadCaption(cloudflareUid, srtPath, LANGUAGE);

      if (response.success) {
        console.log("         ✅  Caption uploaded successfully");
        log("[OK] " + srtFile + " -> " + cloudflareUid);
        successCount++;
      } else {
        const errorMsg = response.errors?.map((e) => e.message).join(", ") || "Unknown error";
        console.log("         ❌  Failed: " + errorMsg);
        log("[FAIL] " + srtFile + " -> " + cloudflareUid);
        log("  Video name : " + videoName);
        log("  SRT path   : " + srtPath);
        log("  Error      : " + errorMsg);
        log("  Errors     : " + JSON.stringify(response.errors, null, 2));
        log("  Messages   : " + JSON.stringify(response.messages, null, 2));
        log("  Full resp  : " + JSON.stringify(response, null, 2));
        log("");
        failCount++;
      }
    } catch (err) {
      console.log("         ❌  Error: " + err.message);
      log("[ERROR] " + srtFile + " -> " + cloudflareUid);
      log("  Video name : " + videoName);
      log("  Exception  : " + err.message);
      log("  Stack      : " + err.stack);
      log("");
      failCount++;
    }

    // Rate-limit delay
    if (i < matched.length - 1) {
      await sleep(Number(DELAY_MS));
    }
  }

  // Summary
  console.log("\n══════════════════════════════════════════════════════════");
  console.log("📊  Caption Upload Summary:");
  console.log("   ✅  Success:    " + successCount);
  console.log("   ❌  Failed:     " + failCount);
  console.log("   ❓  Unmatched:  " + unmatched.length);
  console.log("   📁  Total SRT:  " + srtFiles.length);
  console.log("══════════════════════════════════════════════════════════\n");

  if (!DRY_RUN) {
    log("--- Summary ---");
    log("Success   : " + successCount);
    log("Failed    : " + failCount);
    log("Unmatched : " + unmatched.length);
    if (unmatched.length > 0) {
      for (const f of unmatched) log("  - " + f);
    }
    log("");
    console.log("📝  Log saved to " + LOG_FILE);
  }
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
