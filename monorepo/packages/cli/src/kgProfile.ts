/**
 * `kg:profile` — create/list/remove `Profile` identity+preferences, plus the `TreeView` lifecycle
 * (`*-view` subcommands) a `Profile` owns, via the shared ApeironNgn service
 * (Aperas-treeview-design.md §11). Deliberately minimal: no rename or per-preference-key
 * subcommand — `Profile.jsonld` is meant to be hand-edited directly like a settings file, matching
 * §7's "no auth, no enforced enum" stance. Addresses a `Profile` by its own `handle` field, and a
 * `TreeView` by its own `name` (both play the identical "stable, globally-unique addressable
 * handle" role) — never a raw node id (`findProfileByHandle`/`findTreeViewByName`, `node.ts`).
 */

import type { Store } from 'oxigraph';
import {
  wrap,
  findProfileByHandle,
  removeProfile,
  findTreeViewByName,
  createTreeView,
  removeTreeViewByName,
  backlinks,
  type Profile,
  type TreeView,
  type ApeironNode,
} from '@aperas/core/apeironNgn/node';
import { allIdsOfKind } from '@aperas/core/apeironNgn/dehydrate';
import { generateNodeId } from '@aperas/core/snowflake';
import { ensureServiceRunning, request } from './apeironNgn/serviceClient';
import { wantsHelp, printHelp } from './kgHelp';

export function runProfileCreate(store: Store, handle: string, name?: string, kind?: string): { id: string } {
  if (findProfileByHandle(store, handle)) throw new Error(`Profile '${handle}' already exists.`);
  const id = `Profile:${generateNodeId()}`;
  const profile = wrap(store, id) as unknown as Profile;
  profile.handle = handle;
  if (name) profile.name = name;
  if (kind) profile.kind = kind; // Optional -- "not yet known" is just left unset
  return { id };
}

interface ProfileLine {
  id: string;
  handle: string;
  name?: string;
  kind?: string;
  viewCount: number;
}

interface ProfileDetail extends ProfileLine {
  preferences: { key: string; value: string }[];
  views: { id: string; name?: string }[];
}

function summarize(store: Store, id: string): ProfileLine {
  const profile = wrap(store, id) as unknown as Profile;
  return {
    id,
    handle: (profile.handle as unknown as string) ?? '',
    name: profile.name as unknown as string | undefined,
    kind: profile.kind as unknown as string | undefined,
    viewCount: backlinks(store, id, 'profile').length,
  };
}

export function runProfileList(store: Store, handle?: string): { profiles: ProfileLine[] } | ProfileDetail {
  if (handle === undefined) {
    return { profiles: allIdsOfKind(store, 'Profile').map((id) => summarize(store, id)) };
  }
  const profile = findProfileByHandle(store, handle);
  if (!profile) throw new Error(`Profile '${handle}' not found.`);
  const views = backlinks(store, profile.id, 'profile') as unknown as TreeView[];
  const preferences = ((profile.preferences as unknown as { key: string; value: string }[] | undefined) ?? [])
    .map(({ key, value }) => ({ key, value }));
  return {
    ...summarize(store, profile.id),
    preferences,
    views: views.map((v) => ({ id: v.id, name: v.name as unknown as string | undefined })),
  };
}

export function runProfileRemove(store: Store, handle: string): { removed: boolean; viewsRemoved: number } {
  return removeProfile(store, handle);
}

export function runProfileCreateView(store: Store, name: string, profileHandle: string): { id: string } {
  return createTreeView(store, name, profileHandle);
}

interface ViewLine {
  id: string;
  name: string;
  profileHandle?: string;
  unfoldCount: number;
}

interface ViewDetail extends ViewLine {
  unfolds: string[];
}

function summarizeView(store: Store, id: string): ViewLine {
  const view = wrap(store, id) as unknown as TreeView;
  const profile = view.profile as unknown as Profile | undefined;
  return {
    id,
    name: (view.name as unknown as string) ?? '',
    profileHandle: profile?.handle as unknown as string | undefined,
    unfoldCount: ((view.unfolds as unknown as ApeironNode[] | undefined) ?? []).length,
  };
}

export function runProfileListView(store: Store, name?: string): { views: ViewLine[] } | ViewDetail {
  if (name === undefined) {
    return { views: allIdsOfKind(store, 'TreeView').map((id) => summarizeView(store, id)) };
  }
  const view = findTreeViewByName(store, name);
  if (!view) throw new Error(`TreeView '${name}' not found.`);
  const unfolds = ((view.unfolds as unknown as ApeironNode[] | undefined) ?? []).map((n) => n.id);
  return { ...summarizeView(store, view.id), unfolds };
}

export function runProfileRemoveView(store: Store, name: string): { removed: boolean } {
  return removeTreeViewByName(store, name);
}

export async function main(): Promise<void> {
  const rawArgs = process.argv.slice(2);
  if (wantsHelp(rawArgs)) {
    printHelp({
      description: 'Create/list/remove a Profile — lightweight identity (handle/name/kind) plus an open preferences bag — and the TreeViews it owns. Anything beyond these operations is meant to be hand-edited directly in Profile.jsonld.',
      usage: [
        'aperas profile create <handle> [--name <name>] [--kind <kind>] [--flush] [--reload]',
        'aperas profile list [<handle>] [--reload]',
        'aperas profile remove <handle> [--flush] [--reload]',
        'aperas profile create-view <name> --profile <handle> [--flush] [--reload]',
        'aperas profile list-view [<name>] [--reload]',
        'aperas profile remove-view <name> [--flush] [--reload]',
      ],
      args: [
        { name: '<handle>', description: 'Stable, addressable slug identifying a profile (e.g. "default", "will", "claude-agent-1") — not the same as the profile\'s own opaque node id.' },
        { name: '<name>', description: 'Stable, globally-unique addressable slug identifying a TreeView (the same "handle" role, for views) — the value `--view <name>` on kg:tree/kg:unfold/kg:fold takes.' },
      ],
      flags: [
        { name: '--name <name>', description: 'Display/social name (create only).' },
        { name: '--kind <kind>', description: 'Open category label, e.g. "human"/"agent". Left unset if omitted (create only).' },
        { name: '--profile <handle>', description: 'Owning profile for the new view (create-view only) — must already exist; never implicitly created.' },
        { name: '--flush', description: 'Force an immediate sync to disk after this call, instead of waiting for the normal flush timer.' },
        { name: '--reload', description: 'Reload the store from disk first, in case something else (e.g. a git pull) changed it since the service started.' },
      ],
    });
    return;
  }

  const [subcommand, ...rest] = rawArgs;
  const flush = rest.includes('--flush');
  const reload = rest.includes('--reload');
  const valueFlags = ['--name', '--kind', '--profile'];
  const positional = rest.filter((a, i) =>
    a !== '--flush' && a !== '--reload' && !valueFlags.includes(a) && !valueFlags.includes(rest[i - 1])
  );
  const nameIdx = rest.indexOf('--name');
  const name = nameIdx !== -1 ? rest[nameIdx + 1] : undefined;
  const kindIdx = rest.indexOf('--kind');
  const kind = kindIdx !== -1 ? rest[kindIdx + 1] : undefined;
  const profileIdx = rest.indexOf('--profile');
  const profileHandle = profileIdx !== -1 ? rest[profileIdx + 1] : undefined;

  await ensureServiceRunning();

  switch (subcommand) {
    case 'create': {
      const [handle] = positional;
      if (!handle) {
        console.error('Usage: aperas profile create <handle> [--name <name>] [--kind <kind>] [--flush] [--reload]');
        process.exit(1);
      }
      const { id } = await request<ReturnType<typeof runProfileCreate>>({ op: 'profileCreate', handle, name, kind, flush, reload });
      console.log(`[ApeironNgn kg:profile] Created '${handle}' (${id}).`);
      return;
    }
    case 'list': {
      const [handle] = positional;
      const result = await request<ReturnType<typeof runProfileList>>({ op: 'profileList', handle, reload });
      if ('profiles' in result) {
        if (result.profiles.length === 0) {
          console.log('[ApeironNgn kg:profile] No profiles yet.');
          return;
        }
        for (const p of result.profiles) {
          console.log(`${p.handle}  [${p.kind ?? '-'}]  ${p.name ?? ''}  (${p.viewCount} view(s))  ${p.id}`);
        }
      } else {
        console.log(`${result.handle}  [${result.kind ?? '-'}]  ${result.name ?? ''}  ${result.id}`);
        for (const pref of result.preferences) console.log(`  ${pref.key} = ${pref.value}`);
        for (const v of result.views) console.log(`  view: ${v.id}  ${v.name ?? ''}`);
      }
      return;
    }
    case 'remove': {
      const [handle] = positional;
      if (!handle) {
        console.error('Usage: aperas profile remove <handle> [--flush] [--reload]');
        process.exit(1);
      }
      const { removed, viewsRemoved } = await request<ReturnType<typeof runProfileRemove>>({ op: 'profileRemove', handle, flush, reload });
      if (!removed) {
        console.log(`[ApeironNgn kg:profile] No profile '${handle}' found.`);
        process.exit(1);
      }
      console.log(`[ApeironNgn kg:profile] Removed '${handle}' (and ${viewsRemoved} view(s) it owned).`);
      return;
    }
    case 'create-view': {
      const [name] = positional;
      if (!name || !profileHandle) {
        console.error('Usage: aperas profile create-view <name> --profile <handle> [--flush] [--reload]');
        process.exit(1);
      }
      const { id } = await request<ReturnType<typeof runProfileCreateView>>({ op: 'profileCreateView', name, profileHandle, flush, reload });
      console.log(`[ApeironNgn kg:profile] Created view '${name}' (${id}) under profile '${profileHandle}'.`);
      return;
    }
    case 'list-view': {
      const [name] = positional;
      const result = await request<ReturnType<typeof runProfileListView>>({ op: 'profileListView', name, reload });
      if ('views' in result) {
        if (result.views.length === 0) {
          console.log('[ApeironNgn kg:profile] No views yet.');
          return;
        }
        for (const v of result.views) {
          console.log(`${v.name}  profile: ${v.profileHandle ?? '?'}  (${v.unfoldCount} unfold(s))  ${v.id}`);
        }
      } else {
        console.log(`${result.name}  profile: ${result.profileHandle ?? '?'}  ${result.id}`);
        for (const u of result.unfolds) console.log(`  unfolds: ${u}`);
      }
      return;
    }
    case 'remove-view': {
      const [name] = positional;
      if (!name) {
        console.error('Usage: aperas profile remove-view <name> [--flush] [--reload]');
        process.exit(1);
      }
      const { removed } = await request<ReturnType<typeof runProfileRemoveView>>({ op: 'profileRemoveView', name, flush, reload });
      if (!removed) {
        console.log(`[ApeironNgn kg:profile] No view '${name}' found.`);
        process.exit(1);
      }
      console.log(`[ApeironNgn kg:profile] Removed view '${name}'.`);
      return;
    }
    default:
      console.error('Usage: aperas profile <create|list|remove|create-view|list-view|remove-view> ...  (--help for details)');
      process.exit(1);
  }
}

if (process.argv[1]?.endsWith('kgProfile.ts')) {
  main().catch((err) => {
    console.error('[ApeironNgn kg:profile] Failed:', err.message || err);
    process.exit(1);
  });
}
