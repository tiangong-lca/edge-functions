import { assertEquals, assertThrows } from 'jsr:@std/assert';
import type { SupabaseClient } from '@supabase/supabase-js@2';

import { parseTeamAcceptInvitationCommand } from '../supabase/functions/_shared/commands/membership/accept_invitation.ts';
import { executeTeamChangeMemberRoleCommand } from '../supabase/functions/_shared/commands/membership/change_role.ts';
import { parseTeamRejectInvitationCommand } from '../supabase/functions/_shared/commands/membership/reject_invitation.ts';
import { createMembershipCommandRepository } from '../supabase/functions/_shared/commands/membership/repository.ts';
import {
  executeTeamSetRankCommand,
  executeTeamUpdateProfileCommand,
} from '../supabase/functions/_shared/commands/profile/update_team_profile.ts';
import { executeUserUpdateContactCommand } from '../supabase/functions/_shared/commands/profile/update_user_contact.ts';
import { executeTeamCreateCommand } from '../supabase/functions/_shared/commands/team/create_team.ts';

const TEST_ACTOR_ID = '11111111-1111-4111-8111-111111111111';
const TEST_TEAM_ID = '22222222-2222-4222-8222-222222222222';
const TEST_USER_ID = '33333333-3333-4333-8333-333333333333';

class FakeRpcSupabase {
  rpcCalls: Array<{ fn: string; args: unknown }> = [];

  rpc(fn: string, args: unknown) {
    this.rpcCalls.push({
      fn,
      args: structuredClone(args),
    });

    return Promise.resolve({
      data: {
        ok: true,
        data: {
          accepted: true,
        },
      },
      error: null,
    });
  }
}

function buildActor(supabase: FakeRpcSupabase) {
  return {
    userId: TEST_ACTOR_ID,
    accessToken: 'access-token',
    supabase: supabase as unknown as SupabaseClient,
  };
}

Deno.test('accept invitation payload parser is strict', () => {
  const parsed = parseTeamAcceptInvitationCommand({
    teamId: TEST_TEAM_ID,
    extra: 'nope',
  });

  assertEquals(parsed.ok, false);
});

Deno.test('reject invitation payload parser is strict', () => {
  const parsed = parseTeamRejectInvitationCommand({
    teamId: TEST_TEAM_ID,
    unexpected: true,
  });

  assertEquals(parsed.ok, false);
});

Deno.test('createMembershipCommandRepository requires an explicit Supabase client', () => {
  assertThrows(
    () => createMembershipCommandRepository(undefined as never),
    Error,
    'Membership command repository requires an explicit Supabase client',
  );
});

Deno.test(
  'executeTeamChangeMemberRoleCommand supports remove action and forwards cmd_team_change_member_role args',
  async () => {
    const supabase = new FakeRpcSupabase();
    const result = await executeTeamChangeMemberRoleCommand(
      {
        teamId: TEST_TEAM_ID,
        userId: TEST_USER_ID,
        action: 'remove',
      },
      buildActor(supabase),
    );

    assertEquals(result.ok, true);
    assertEquals(supabase.rpcCalls, [
      {
        fn: 'cmd_team_change_member_role',
        args: {
          p_team_id: TEST_TEAM_ID,
          p_user_id: TEST_USER_ID,
          p_role: null,
          p_action: 'remove',
          p_audit: {
            command: 'team_change_member_role',
            actorUserId: TEST_ACTOR_ID,
            targetTable: 'roles',
            targetId: TEST_USER_ID,
            targetVersion: TEST_TEAM_ID,
            payload: {
              action: 'remove',
              role: null,
              teamId: TEST_TEAM_ID,
            },
          },
        },
      },
    ]);
  },
);

Deno.test('executeTeamCreateCommand forwards cmd_team_create args with audit payload', async () => {
  const supabase = new FakeRpcSupabase();
  const teamJson = { title: [{ '@xml:lang': 'en', '#text': 'Team A' }] };

  const result = await executeTeamCreateCommand(
    {
      teamId: TEST_TEAM_ID,
      json: teamJson,
      rank: 1,
      isPublic: false,
    },
    buildActor(supabase),
  );

  assertEquals(result.ok, true);
  assertEquals(supabase.rpcCalls, [
    {
      fn: 'cmd_team_create',
      args: {
        p_team_id: TEST_TEAM_ID,
        p_json: teamJson,
        p_rank: 1,
        p_is_public: false,
        p_audit: {
          command: 'team_create',
          actorUserId: TEST_ACTOR_ID,
          targetTable: 'teams',
          targetId: TEST_TEAM_ID,
          targetVersion: '',
          payload: {
            rank: 1,
            isPublic: false,
          },
        },
      },
    },
  ]);
});

Deno.test('profile and user commands forward exact RPC names and args', async () => {
  const supabase = new FakeRpcSupabase();
  const actor = buildActor(supabase);

  await executeTeamUpdateProfileCommand(
    {
      teamId: TEST_TEAM_ID,
      json: { description: [{ '@xml:lang': 'en', '#text': 'Updated' }] },
      isPublic: true,
    },
    actor,
  );

  await executeTeamSetRankCommand(
    {
      teamId: TEST_TEAM_ID,
      rank: 5,
    },
    actor,
  );

  await executeUserUpdateContactCommand(
    {
      userId: TEST_USER_ID,
      contact: {
        '@refObjectId': '44444444-4444-4444-8444-444444444444',
      },
    },
    actor,
  );

  assertEquals(supabase.rpcCalls, [
    {
      fn: 'cmd_team_update_profile',
      args: {
        p_team_id: TEST_TEAM_ID,
        p_json: { description: [{ '@xml:lang': 'en', '#text': 'Updated' }] },
        p_is_public: true,
        p_audit: {
          command: 'team_update_profile',
          actorUserId: TEST_ACTOR_ID,
          targetTable: 'teams',
          targetId: TEST_TEAM_ID,
          targetVersion: '',
          payload: {
            isPublic: true,
          },
        },
      },
    },
    {
      fn: 'cmd_team_set_rank',
      args: {
        p_team_id: TEST_TEAM_ID,
        p_rank: 5,
        p_audit: {
          command: 'team_set_rank',
          actorUserId: TEST_ACTOR_ID,
          targetTable: 'teams',
          targetId: TEST_TEAM_ID,
          targetVersion: '',
          payload: {
            rank: 5,
          },
        },
      },
    },
    {
      fn: 'cmd_user_update_contact',
      args: {
        p_user_id: TEST_USER_ID,
        p_contact: {
          '@refObjectId': '44444444-4444-4444-8444-444444444444',
        },
        p_audit: {
          command: 'user_update_contact',
          actorUserId: TEST_ACTOR_ID,
          targetTable: 'users',
          targetId: TEST_USER_ID,
          targetVersion: '',
          payload: {
            hasContact: true,
          },
        },
      },
    },
  ]);
});
