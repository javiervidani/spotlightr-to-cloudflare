#!/usr/bin/env node

/**
 * Spotlightr → Cloudflare Stream Migration Tool
 *
 * Reads a Spotlightr CSV export, extracts the original video URLs,
 * and uploads each video to Cloudflare Stream using the "copy from URL" API.
 *
 * Usage:
 *   1. Copy .env.example to .env and fill in your Cloudflare credentials
 *   2. npm install
 *   3. node migrate.js
 *
 * Optional flags:
 *   --dry-run    Preview what would be migrated without making API calls
 *   --project=ID Only migrate videos from a specific Spotlightr project
 */

import "dotenv/config";
import { parse } from "csv-parse/sync";
import { readFileSync, writeFileSync, existsSync } from "fs";

// ─── Configuration ──────────────────────────────────────────────────────────────

const {
  CLOUDFLARE_API_TOKEN,
  CLOUDFLARE_ACCOUNT_ID,
  CSV_FILE = "Dashboard_Projects_All_Videos_Spotlightr.csv",
  DELAY_MS = "2000",
} = process.env;

if (!CLOUDFLARE_API_TOKEN || !CLOUDFLARE_ACCOUNT_ID) {
  console.error("❌  Missing CLOUDFLARE_API_TOKEN or CLOUDFLARE_ACCOUNT_ID in .env");
  process.exit(1);
}

const API_URL = `https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}/stream/copy`;
const RESULTS_FILE = "migration-results.json";

// ─── CLI Flags ──────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const DRY_RUN = args.includes("--dry-run");
const projectFlag = args.find((a) => a.startsWith("--project="));
const FILTER_PROJECT = projectFlag ? projectFlag.split("=")[1] : null;

// ─── Helpers ────────────────────────────────────────────────────────────────────

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function loadPreviousResults() {
  if (existsSync(RESULTS_FILE)) {
    try {
      return JSON.parse(readFileSync(RESULTS_FILE, "utf-8"));
    } catch {
      return [];
    }
  }
  return [];
}

function saveMigrationResults(results) {
  writeFileSync(RESULTS_FILE, JSON.stringify(results, null, 2), "utf-8");
}

// ─── CSV Parsing ────────────────────────────────────────────────────────────────

function parseCSV(filePath) {
  if (!existsSync(filePath)) {
    console.error(`❌  CSV file not found: ${filePath}`);
    process.exit(1);
  }

  const raw = readFileSync(filePath, "utf-8");
  const records = parse(raw, {
    columns: true,
    skip_empty_lines: true,
    relax_column_count: true,
    relax_quotes: true,
  });

  return records;
}

// ─── Video Filtering ────────────────────────────────────────────────────────────

function extractMigratableVideos(records) {
  const videos = [];

  for (const row of records) {
    const videoName = row["video"] || "";
    const originalUrl = row["original file URL"] || "";
    const projectId = row["project"] || "";
    const spotlightrId = row["id"] || "";
    const hlsUrl = row["URL"] || "";

    // Skip if the original file was deleted
    if (!originalUrl || originalUrl === "DELETED") {
      console.log(`⏭  Skipping "${videoName}" — original file deleted`);
      continue;
    }

    // Filter by project if specified
    if (FILTER_PROJECT && projectId !== FILTER_PROJECT) {
      continue;
    }

    videos.push({
      name: videoName,
      url: originalUrl,
      projectId,
      spotlightrId,
      hlsUrl,
    });
  }

  return videos;
}

// ─── Cloudflare Upload ──────────────────────────────────────────────────────────

async function uploadToCloudflare(video) {
  const body = {
    url: video.url,
    meta: {
      name: video.name,
      spotlightrId: video.spotlightrId,
      spotlightrProject: video.projectId,
    },
  };

  const response = await fetch(API_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${CLOUDFLARE_API_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  const data = await response.json();
  return data;
}

// ─── Main ───────────────────────────────────────────────────────────────────────

async function main() {
  console.log("╔══════════════════════════════════════════════════════════╗");
  console.log("║   Spotlightr → Cloudflare Stream Migration Tool        ║");
  console.log("╚══════════════════════════════════════════════════════════╝");
  console.log();

  if (DRY_RUN) {
    console.log("🏃  DRY RUN MODE — no API calls will be made\n");
  }

  // Load CSV
  console.log(`📂  Reading CSV: ${CSV_FILE}`);
  const records = parseCSV(CSV_FILE);
  console.log(`   Found ${records.length} total records\n`);

  // Extract migratable videos
  const videos = extractMigratableVideos(records);
  console.log(`\n🎬  ${videos.length} videos ready for migration\n`);

  if (videos.length === 0) {
    console.log("Nothing to migrate. Exiting.");
    return;
  }

  // Load previous results to skip already-migrated videos
  const previousResults = loadPreviousResults();
  const alreadyMigrated = new Set(previousResults.filter((r) => r.success).map((r) => r.spotlightrId));
  const results = [...previousResults];

  let successCount = 0;
  let skipCount = 0;
  let failCount = 0;

  for (let i = 0; i < videos.length; i++) {
    const video = videos[i];
    const progress = `[${i + 1}/${videos.length}]`;

    // Skip if already migrated
    if (alreadyMigrated.has(video.spotlightrId)) {
      console.log(`${progress} ⏭  "${video.name}" — already migrated`);
      skipCount++;
      continue;
    }

    if (DRY_RUN) {
      console.log(`${progress} 🔍  Would upload: "${video.name}"`);
      console.log(`         URL: ${video.url}`);
      successCount++;
      continue;
    }

    try {
      console.log(`${progress} 🚀  Uploading: "${video.name}"`);
      const response = await uploadToCloudflare(video);

      if (response.success) {
        const cfUid = response.result?.uid || "unknown";
        console.log(`         ✅  Success — Cloudflare UID: ${cfUid}`);
        results.push({
          spotlightrId: video.spotlightrId,
          name: video.name,
          projectId: video.projectId,
          sourceUrl: video.url,
          cloudflareUid: cfUid,
          success: true,
          timestamp: new Date().toISOString(),
        });
        successCount++;
      } else {
        const errorMsg = response.errors?.map((e) => e.message).join(", ") || "Unknown error";
        console.log(`         ❌  Failed: ${errorMsg}`);
        results.push({
          spotlightrId: video.spotlightrId,
          name: video.name,
          projectId: video.projectId,
          sourceUrl: video.url,
          success: false,
          error: errorMsg,
          timestamp: new Date().toISOString(),
        });
        failCount++;
      }
    } catch (err) {
      console.log(`         ❌  Error: ${err.message}`);
      results.push({
        spotlightrId: video.spotlightrId,
        name: video.name,
        projectId: video.projectId,
        sourceUrl: video.url,
        success: false,
        error: err.message,
        timestamp: new Date().toISOString(),
      });
      failCount++;
    }

    // Save results after each video (resume-safe)
    saveMigrationResults(results);

    // Rate-limit delay
    if (i < videos.length - 1) {
      await sleep(Number(DELAY_MS));
    }
  }

  // Final summary
  console.log("\n══════════════════════════════════════════════════════════");
  console.log("📊  Migration Summary:");
  console.log(`   ✅  Success:  ${successCount}`);
  console.log(`   ⏭   Skipped:  ${skipCount}`);
  console.log(`   ❌  Failed:   ${failCount}`);
  console.log(`   📁  Total:    ${videos.length}`);
  if (!DRY_RUN) {
    console.log(`\n💾  Results saved to ${RESULTS_FILE}`);
  }
  console.log("══════════════════════════════════════════════════════════\n");
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
