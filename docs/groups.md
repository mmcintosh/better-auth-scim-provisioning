# Groups

With `groups: true`, each organization (Better Auth's organization plugin) is a group at the app, or only `organizationId`'s when that's set. With a function, only the organizations it returns true for: `groups: (org) => org.slug.startsWith("team-")`.

> **Who can name a group?** Better Auth lets any signed-in user create organizations by default, and each organization becomes a group at the app. A user could then create one called "Administrators", with themselves in it. Some apps match access rules by group name. Restrict who creates and renames organizations (the organization plugin's `allowUserToCreateOrganization` and roles), or choose groups with a function.

The group's members are the organization's members who are provisioned and active at that target, so a banned or unverified member isn't in it.

**Teams and roles** can be groups too, the same way:
- `teamGroups: true`: each team (the organization plugin's `teams`) is a group of its provisioned members, named "Acme / Red". A function chooses which: `teamGroups: (team, org) => team.name.startsWith("eng-")`. `teamGroupName: (team, org) => string` names them.
- `roleGroups: ["admin"]`: the members holding that role in each organization are a group, named "Acme / admin"; `roleGroups: true` makes one for every role held. A member with several roles is in each role's group. `roleGroupName: (role, org) => string` names them.

All three kinds can be used together. Any change in an organization (members, roles, teams, the organization itself) updates its groups; a removed team, or (with `roleGroups: true`) a role no one holds any more, has its group removed at the app. A role named in a `roleGroups` list keeps its group even while no one holds it.

- **When it changes:**
  - members join or leave (add, remove, accepting an invitation, leaving), change role, or join or leave a team;
  - a member is provisioned, deprovisioned or deleted;
  - the organization or team is renamed (the group is renamed) or deleted (the group is removed at the app);
  - a reconcile runs.
- **Rebuilt each time:** the group is recomputed from the database on every delivery, so it converges whatever order changes arrive in. A change made in the app is delivered at once; a reconcile updates each group a few times, not once per member.
- **Never taken over:** a group of the same name that isn't the organization's (another `externalId`, or one made by hand) is refused, because replacing it would rewrite its members. The name is looked up before the first create. If that create fails or its reply is lost, a group found later without our `externalId` is taken as ours only when everyone in it is someone we'd put there; otherwise it's refused. Rename one of them, or set `groupName`.
- **Verified** at Cloudflare Access (in the field test, by hand), Google Workspace and AWS IAM Identity Center (live tests).

Most apps grant access by group: assign the group to the app or role there (AWS permission sets, Atlassian products, Cloudflare Access policies).
