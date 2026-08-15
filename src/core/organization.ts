/**
 * Comparing an organisation against its declared policy.
 *
 * Everything else octoform plans belongs to a repository. These settings
 * belong to the account above them, and two of them — the base permission and
 * what members may create — decide things about every repository the
 * organisation owns, including the ones no configuration mentions. That is why
 * they are planned and reported like any other change rather than applied by a
 * command of their own: a setting with that reach should never be the one
 * thing nobody saw a diff for.
 */

import { isManaged } from '../config/resolve.js';
import { UNREADABLE } from '../config/sentinels.js';
import type { Change, OrganizationPolicy, OwnerKind, Risk, SettingValue } from '../types/index.js';

/** Every setting of the organisation itself, by the key a change carries. */
export const ORGANIZATION_KEYS: readonly string[] = [
  'organization.profile.name',
  'organization.profile.description',
  'organization.profile.company',
  'organization.profile.website',
  'organization.profile.location',
  'organization.profile.email',
  'organization.profile.twitter_username',
  'organization.members.base_permission',
  'organization.members.create_repositories',
  'organization.members.create_public_repositories',
  'organization.members.create_private_repositories',
  'organization.members.create_internal_repositories',
  'organization.members.fork_private_repositories',
  'organization.members.create_pages',
  'organization.members.create_public_pages',
  'organization.members.create_private_pages',
  'organization.members.web_commit_signoff_required',
  'organization.members.deploy_keys_enabled',
  'organization.members.organization_projects',
  'organization.members.repository_projects',
];

/**
 * The field each key is read from and written to, which is the same field in
 * both directions for every one of them.
 *
 * `website` is the exception in name only: GitHub calls it `blog`, and the
 * configuration does not, because nothing about it is a blog.
 */
export const ORGANIZATION_FIELDS: Readonly<Record<string, string>> = {
  'organization.profile.name': 'name',
  'organization.profile.description': 'description',
  'organization.profile.company': 'company',
  'organization.profile.website': 'blog',
  'organization.profile.location': 'location',
  'organization.profile.email': 'email',
  'organization.profile.twitter_username': 'twitter_username',
  'organization.members.base_permission': 'default_repository_permission',
  'organization.members.create_repositories': 'members_can_create_repositories',
  'organization.members.create_public_repositories': 'members_can_create_public_repositories',
  'organization.members.create_private_repositories': 'members_can_create_private_repositories',
  'organization.members.create_internal_repositories': 'members_can_create_internal_repositories',
  'organization.members.fork_private_repositories': 'members_can_fork_private_repositories',
  'organization.members.create_pages': 'members_can_create_pages',
  'organization.members.create_public_pages': 'members_can_create_public_pages',
  'organization.members.create_private_pages': 'members_can_create_private_pages',
  'organization.members.web_commit_signoff_required': 'web_commit_signoff_required',
  'organization.members.deploy_keys_enabled': 'deploy_keys_enabled_for_repositories',
  'organization.members.organization_projects': 'has_organization_projects',
  'organization.members.repository_projects': 'has_repository_projects',
};

/**
 * Settings that decide something about every repository the organisation owns,
 * including the ones the configuration says nothing about.
 *
 * Lowering the base permission takes access away from people who never
 * appeared in any repository's policy, and turning creation off changes what
 * the whole organisation can do tomorrow. Neither belongs in the same bucket
 * as a description.
 */
const REACHES_EVERY_REPOSITORY: ReadonlySet<string> = new Set([
  'organization.members.base_permission',
  'organization.members.create_repositories',
  'organization.members.create_public_repositories',
  'organization.members.create_private_repositories',
  'organization.members.create_internal_repositories',
  'organization.members.fork_private_repositories',
  'organization.members.web_commit_signoff_required',
  'organization.members.deploy_keys_enabled',
]);

/** What a policy declares, flattened onto the keys a change carries. */
export function declaredOrganization(policy: OrganizationPolicy): Map<string, unknown> {
  const declared = new Map<string, unknown>();
  for (const [group, values] of [
    ['profile', policy.profile],
    ['members', policy.members],
  ] as const) {
    for (const [name, value] of Object.entries(values ?? {})) {
      declared.set(`organization.${group}.${name}`, value);
    }
  }
  return declared;
}

/**
 * Compare an organisation against its policy.
 *
 * @param owner - The organisation login.
 * @param ownerKind - What the login turned out to be.
 * @param current - Observed settings, keyed the way a change names them.
 * @param policy - The declared organisation policy.
 */
export function planOrganization(
  owner: string,
  ownerKind: OwnerKind,
  current: Record<string, SettingValue> | undefined,
  policy: OrganizationPolicy | undefined,
): Change[] {
  if (!policy) return [];

  const changes: Change[] = [];
  const draft = (key: string, from: unknown, to: unknown, blocked?: string): void => {
    changes.push({
      id: `${owner}#${key}`,
      owner,
      key,
      operation: from === null || from === undefined ? 'create' : 'update',
      risk: riskOf(key),
      prerequisites: [],
      from,
      to,
      ...(blocked === undefined ? {} : { blocked }),
    });
  };

  for (const [key, wanted] of declaredOrganization(policy)) {
    if (!isManaged(wanted)) continue;

    if (ownerKind === 'user') {
      draft(
        key,
        null,
        wanted,
        `"${owner}" is a personal account, which has none of the organisation settings`,
      );
      continue;
    }

    const held = current?.[key];
    if (held === undefined) {
      draft(key, UNREADABLE, wanted, 'could not read the current organisation settings');
      continue;
    }
    if (held === UNREADABLE) {
      draft(key, held, wanted, 'current value could not be read, so the change was not attempted');
      continue;
    }
    if (same(held, wanted)) continue;

    draft(key, held, wanted);
  }

  return changes;
}

function riskOf(key: string): Risk {
  return REACHES_EVERY_REPOSITORY.has(key) ? 'sensitive' : 'normal';
}

/** Unset and empty string are the same absence, the way they are on a repository. */
function same(current: unknown, wanted: unknown): boolean {
  if ((current === '' || current === null) && (wanted === '' || wanted === null)) return true;
  return current === wanted;
}
