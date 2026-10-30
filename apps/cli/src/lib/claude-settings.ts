import { isDeepStrictEqual } from 'node:util';
import { MeshError } from '@agentmesh/common';
import { z } from 'zod';
import { DEFAULT_MARKETPLACE, DEFAULT_MARKETPLACE_NAME } from '../setup/defaults';

/**
 * Pure edits of Claude Code's own files for `agentmesh autoupdate`. Errors never quote the
 * text they were given: settings.json can hold env values and tokens.
 */

export type MarketplaceSource = Record<string, unknown>;

/** Where the default marketplace lives when Claude Code's own record cannot be read. */
export const FALLBACK_SOURCE: MarketplaceSource = { source: 'github', repo: DEFAULT_MARKETPLACE };

const KnownMarketplace = z.looseObject({ source: z.looseObject({ source: z.string() }) });

const Settings = z.looseObject({
  extraKnownMarketplaces: z.record(z.string(), z.looseObject({})).optional(),
});

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text.replace(/^﻿/, ''));
  } catch {
    return undefined;
  }
}

/**
 * The source Claude Code recorded for marketplace `name` when the user added it
 * (`known_marketplaces.json`: an object keyed by marketplace name). Reusing it matters: a
 * settings source that differs from the added one makes Claude Code fetch the marketplace again.
 * Missing or unreadable, the default marketplace falls back to its GitHub repo; another name
 * cannot be guessed.
 */
export function marketplaceSource(knownText: string | undefined, name: string): MarketplaceSource {
  const known = knownText === undefined ? undefined : parseJson(knownText);
  const entry =
    known !== null && typeof known === 'object' && Object.hasOwn(known, name)
      ? KnownMarketplace.safeParse((known as Record<string, unknown>)[name])
      : undefined;
  if (entry?.success) return entry.data.source;
  if (name === DEFAULT_MARKETPLACE_NAME) return FALLBACK_SOURCE;
  throw new MeshError(
    'invalid_request',
    `Claude Code has no marketplace named "${name}". Add it with \`claude plugin marketplace add <source>\` first.`,
  );
}

/**
 * settings.json with `extraKnownMarketplaces[name]` set to `{...entry, source, autoUpdate}`.
 * Every other key stays as it was. A missing file starts from `{}`; text that is not a JSON
 * object (or has a malformed `extraKnownMarketplaces`) is refused, so nothing is lost.
 */
export function setAutoUpdate(
  settingsText: string | undefined,
  name: string,
  source: MarketplaceSource,
  autoUpdate: boolean,
): { text: string; changed: boolean } {
  const settings = settingsText === undefined ? {} : parseJson(settingsText);
  if (!Settings.safeParse(settings).success) {
    throw new MeshError(
      'invalid_request',
      'settings.json is not a JSON object with an object-valued extraKnownMarketplaces; fix it in an editor, then run this again. Nothing was changed.',
    );
  }
  const root = settings as Record<string, unknown> & {
    extraKnownMarketplaces?: Record<string, Record<string, unknown>>;
  };
  const marketplaces = root.extraKnownMarketplaces ?? {};
  const before = Object.hasOwn(marketplaces, name) ? marketplaces[name] : undefined;
  const after = { ...before, source, autoUpdate };
  const next = { ...root, extraKnownMarketplaces: { ...marketplaces, [name]: after } };
  return { text: `${JSON.stringify(next, null, 2)}\n`, changed: !isDeepStrictEqual(before, after) };
}
