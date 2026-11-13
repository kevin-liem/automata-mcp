/**
 * The app's schema, as an ordered list of migrations.
 *
 * TypeScript strings rather than `.sql` files so they are bundled into the Nitro
 * output with no copy step — a migration that is missing from the image is a
 * deployment with no tables. Applied at boot by `migrateAppDb()` in
 * `server/utils/app-db.ts`, under an advisory lock, in one transaction.
 *
 * Append only. A migration that has been deployed is never edited: its name is
 * recorded in `app.migrations` and it will not run again, so an edit reaches
 * fresh databases and silently skips every existing one.
 *
 * Every table lives in the `app` schema, never `public`: this is the same
 * Postgres database Evolution writes into (and the Telegram bridge, under
 * `telegram`), and Evolution owns `public`.
 */
export interface AppMigration {
  name: string
  sql: string
}

export const APP_MIGRATIONS: AppMigration[] = [
  {
    name: '0001_init',
    sql: /* sql */ `
      -- Ids are text so rows imported from PocketBase keep the ids they had —
      -- they are in URLs, in the browser's history, and in token labels people
      -- have written down. New rows get a uuid.

      CREATE TABLE app.users (
        id            text PRIMARY KEY DEFAULT gen_random_uuid()::text,
        -- Stored lower-cased and trimmed (normaliseEmail), which is also what
        -- invitation acceptance compares against.
        email         text NOT NULL CHECK (email = lower(btrim(email)) AND email <> ''),
        name          text NOT NULL DEFAULT '',
        -- scrypt$..., or a bcrypt $2a$/$2b$ hash carried over from PocketBase and
        -- replaced by scrypt on that user's next successful sign-in.
        password_hash text NOT NULL,
        created       timestamptz NOT NULL DEFAULT now(),
        updated       timestamptz NOT NULL DEFAULT now()
      );
      CREATE UNIQUE INDEX users_email_key ON app.users (email);

      -- A browser session. Only the SHA-256 of the cookie value is stored, the
      -- same handling an MCP token gets.
      CREATE TABLE app.sessions (
        id           text PRIMARY KEY DEFAULT gen_random_uuid()::text,
        user_id      text NOT NULL REFERENCES app.users (id) ON DELETE CASCADE,
        token_hash   text NOT NULL CHECK (length(token_hash) = 64),
        expires_at   timestamptz NOT NULL,
        created      timestamptz NOT NULL DEFAULT now()
      );
      CREATE UNIQUE INDEX sessions_token_hash_key ON app.sessions (token_hash);
      CREATE INDEX sessions_user_idx ON app.sessions (user_id);

      CREATE TABLE app.organizations (
        id      text PRIMARY KEY DEFAULT gen_random_uuid()::text,
        name    text NOT NULL CHECK (length(name) BETWEEN 1 AND 100),
        created timestamptz NOT NULL DEFAULT now(),
        updated timestamptz NOT NULL DEFAULT now()
      );

      -- One organization per user: the unique index on user_id is that rule,
      -- and why accepting an invitation is an UPDATE of this row.
      CREATE TABLE app.memberships (
        id      text PRIMARY KEY DEFAULT gen_random_uuid()::text,
        org     text NOT NULL REFERENCES app.organizations (id) ON DELETE CASCADE,
        user_id text NOT NULL REFERENCES app.users (id) ON DELETE CASCADE,
        role    text NOT NULL CHECK (role IN ('admin', 'member')),
        created timestamptz NOT NULL DEFAULT now(),
        updated timestamptz NOT NULL DEFAULT now()
      );
      CREATE UNIQUE INDEX memberships_user_key ON app.memberships (user_id);
      CREATE INDEX memberships_org_idx ON app.memberships (org);

      CREATE TABLE app.instances (
        id               text PRIMARY KEY DEFAULT gen_random_uuid()::text,
        -- RESTRICT, not CASCADE: deleting an organization that still owns
        -- connections must fail loudly rather than drop rows that point at live
        -- sockets on real phone numbers. deleteInstance() is the only way out.
        org              text NOT NULL REFERENCES app.organizations (id) ON DELETE RESTRICT,
        -- Provenance only. SET NULL for the same reason: a creator's account
        -- going must never take a connection with it.
        created_by       text REFERENCES app.users (id) ON DELETE SET NULL,
        kind             text NOT NULL CHECK (kind IN ('whatsapp', 'postgres', 'telegram')),
        name             text NOT NULL,
        instance_id      text NOT NULL DEFAULT '',
        api_key          text NOT NULL DEFAULT '',
        admin_key        text NOT NULL DEFAULT '',
        base_url         text NOT NULL DEFAULT '',
        evolution_db_url text NOT NULL DEFAULT '',
        telegram_db_url  text NOT NULL DEFAULT '',
        dsn              text NOT NULL DEFAULT '',
        db_host          text NOT NULL DEFAULT '',
        db_port          integer,
        db_database      text NOT NULL DEFAULT '',
        label            text NOT NULL DEFAULT '',
        down_since       timestamptz,
        alerted_at       timestamptz,
        created          timestamptz NOT NULL DEFAULT now(),
        updated          timestamptz NOT NULL DEFAULT now()
      );
      CREATE UNIQUE INDEX instances_name_key ON app.instances (name);
      CREATE INDEX instances_org_idx ON app.instances (org);

      -- "May use, not manage." Admins hold no rows here.
      CREATE TABLE app.instance_assignments (
        id       text PRIMARY KEY DEFAULT gen_random_uuid()::text,
        instance text NOT NULL REFERENCES app.instances (id) ON DELETE CASCADE,
        user_id  text NOT NULL REFERENCES app.users (id) ON DELETE CASCADE,
        created  timestamptz NOT NULL DEFAULT now()
      );
      CREATE UNIQUE INDEX instance_assignments_key ON app.instance_assignments (instance, user_id);
      CREATE INDEX instance_assignments_user_idx ON app.instance_assignments (user_id);

      CREATE TABLE app.invitations (
        id          text PRIMARY KEY DEFAULT gen_random_uuid()::text,
        org         text NOT NULL REFERENCES app.organizations (id) ON DELETE CASCADE,
        email       text NOT NULL,
        role        text NOT NULL CHECK (role IN ('admin', 'member')),
        code_hash   text NOT NULL CHECK (length(code_hash) = 64),
        invited_by  text REFERENCES app.users (id) ON DELETE SET NULL,
        accepted_by text REFERENCES app.users (id) ON DELETE SET NULL,
        expires_at  timestamptz,
        accepted_at timestamptz,
        revoked     boolean NOT NULL DEFAULT false,
        created     timestamptz NOT NULL DEFAULT now(),
        updated     timestamptz NOT NULL DEFAULT now()
      );
      CREATE UNIQUE INDEX invitations_code_hash_key ON app.invitations (code_hash);
      CREATE INDEX invitations_org_idx ON app.invitations (org);

      CREATE TABLE app.mcp_tokens (
        id           text PRIMARY KEY DEFAULT gen_random_uuid()::text,
        -- CASCADE: a deleted account's tokens must stop working.
        assigned_to  text NOT NULL REFERENCES app.users (id) ON DELETE CASCADE,
        created_by   text REFERENCES app.users (id) ON DELETE SET NULL,
        instance     text NOT NULL REFERENCES app.instances (id) ON DELETE CASCADE,
        token_hash   text NOT NULL CHECK (length(token_hash) = 64),
        label        text NOT NULL DEFAULT '',
        last_used_at timestamptz,
        expires_at   timestamptz,
        revoked      boolean NOT NULL DEFAULT false,
        -- Scope. NOT NULL with a default, so no write path can mint a token
        -- whose scope is an accident of what it forgot to set.
        all_chats    boolean NOT NULL DEFAULT true,
        chat_jids    jsonb NOT NULL DEFAULT '[]'::jsonb,
        all_tables   boolean NOT NULL DEFAULT true,
        table_names  jsonb NOT NULL DEFAULT '[]'::jsonb,
        all_tools    boolean NOT NULL DEFAULT true,
        tool_names   jsonb NOT NULL DEFAULT '[]'::jsonb,
        created      timestamptz NOT NULL DEFAULT now(),
        updated      timestamptz NOT NULL DEFAULT now()
      );
      CREATE UNIQUE INDEX mcp_tokens_token_hash_key ON app.mcp_tokens (token_hash);
      CREATE INDEX mcp_tokens_assigned_to_idx ON app.mcp_tokens (assigned_to);
      CREATE INDEX mcp_tokens_instance_idx ON app.mcp_tokens (instance);
    `,
  },
  {
    name: '0002_two_factor',
    sql: /* sql */ `
      -- Second factors for the web sign-in. None of this touches the MCP
      -- surface: a connector token is its own credential.

      -- An authenticator-app secret, one per user. confirmed_at stays empty
      -- until a code from the app has been checked, so a setup abandoned
      -- halfway is not a factor login asks for. last_step is the newest
      -- 30-second step a code was accepted for; a code from that step or an
      -- older one is refused, so one observed code cannot be replayed.
      -- The secret is a plain column, like the credentials on app.instances.
      CREATE TABLE app.totp_credentials (
        user_id      text PRIMARY KEY REFERENCES app.users (id) ON DELETE CASCADE,
        secret       text NOT NULL,
        last_step    bigint NOT NULL DEFAULT 0,
        confirmed_at timestamptz,
        created      timestamptz NOT NULL DEFAULT now()
      );

      -- A passkey or security key. The public key is not secret; counter is
      -- the authenticator's signature counter (0 for most passkeys).
      CREATE TABLE app.webauthn_credentials (
        id            text PRIMARY KEY DEFAULT gen_random_uuid()::text,
        user_id       text NOT NULL REFERENCES app.users (id) ON DELETE CASCADE,
        credential_id text NOT NULL,
        public_key    bytea NOT NULL,
        counter       bigint NOT NULL DEFAULT 0,
        transports    jsonb NOT NULL DEFAULT '[]'::jsonb,
        name          text NOT NULL DEFAULT '' CHECK (length(name) <= 100),
        created       timestamptz NOT NULL DEFAULT now(),
        last_used_at  timestamptz
      );
      CREATE UNIQUE INDEX webauthn_credentials_credential_id_key ON app.webauthn_credentials (credential_id);
      CREATE INDEX webauthn_credentials_user_idx ON app.webauthn_credentials (user_id);

      -- Single-use recovery codes. Only the SHA-256 is stored; the codes carry
      -- 60 random bits each, so a fast hash is enough.
      CREATE TABLE app.recovery_codes (
        id        text PRIMARY KEY DEFAULT gen_random_uuid()::text,
        user_id   text NOT NULL REFERENCES app.users (id) ON DELETE CASCADE,
        code_hash text NOT NULL CHECK (length(code_hash) = 64),
        used_at   timestamptz,
        created   timestamptz NOT NULL DEFAULT now()
      );
      CREATE UNIQUE INDEX recovery_codes_user_hash_key ON app.recovery_codes (user_id, code_hash);

      -- A sign-in that passed the password and still owes a second factor
      -- ('login'), or a passkey registration in progress ('register'). Never a
      -- session: a row in app.sessions means fully signed in, so nothing that
      -- reads sessions can mistake a half-finished login for one. token_hash is
      -- the SHA-256 of the login cookie; registration rows have none.
      CREATE TABLE app.mfa_challenges (
        id                 text PRIMARY KEY DEFAULT gen_random_uuid()::text,
        user_id            text NOT NULL REFERENCES app.users (id) ON DELETE CASCADE,
        purpose            text NOT NULL CHECK (purpose IN ('login', 'register')),
        token_hash         text CHECK (token_hash IS NULL OR length(token_hash) = 64),
        webauthn_challenge text,
        attempts           integer NOT NULL DEFAULT 0,
        expires_at         timestamptz NOT NULL,
        created            timestamptz NOT NULL DEFAULT now(),
        CHECK ((purpose = 'login') = (token_hash IS NOT NULL))
      );
      CREATE UNIQUE INDEX mfa_challenges_token_hash_key ON app.mfa_challenges (token_hash);
      CREATE INDEX mfa_challenges_user_idx ON app.mfa_challenges (user_id);
    `,
  },
  {
    name: '0003_email_verification',
    sql: /* sql */ `
      -- An address waiting to be proved: a signup ('signup') or a change of
      -- sign-in address ('email_change'). A signup has no app.users row until
      -- it is verified, so a pending row claims nothing: several may name one
      -- address, and the first to verify wins. That is what stops someone
      -- registering an address they do not own ahead of its owner.
      --
      -- link_hash is the SHA-256 of the token in the mailed link; pending_hash
      -- of the cookie that lets the waiting browser type the code instead;
      -- code_hash of the row id and the six-digit code. Five wrong codes delete
      -- the row. password_hash and name are what the account is created with.
      CREATE TABLE app.email_verifications (
        id                 text PRIMARY KEY DEFAULT gen_random_uuid()::text,
        purpose            text NOT NULL CHECK (purpose IN ('signup', 'email_change')),
        email              text NOT NULL CHECK (email = lower(btrim(email)) AND email <> ''),
        link_hash          text NOT NULL CHECK (length(link_hash) = 64),
        pending_hash       text NOT NULL CHECK (length(pending_hash) = 64),
        code_hash          text NOT NULL CHECK (length(code_hash) = 64),
        attempts           integer NOT NULL DEFAULT 0,
        user_id            text REFERENCES app.users (id) ON DELETE CASCADE,
        password_hash      text,
        name               text,
        invite_id          text REFERENCES app.invitations (id) ON DELETE CASCADE,
        first_account_only boolean NOT NULL DEFAULT false,
        expires_at         timestamptz NOT NULL,
        created            timestamptz NOT NULL DEFAULT now(),
        CHECK ((purpose = 'email_change') = (user_id IS NOT NULL)),
        CHECK ((purpose = 'signup') = (password_hash IS NOT NULL))
      );
      CREATE UNIQUE INDEX email_verifications_link_hash_key ON app.email_verifications (link_hash);
      CREATE UNIQUE INDEX email_verifications_pending_hash_key ON app.email_verifications (pending_hash);
      CREATE INDEX email_verifications_user_idx ON app.email_verifications (user_id);
    `,
  },
  {
    name: '0004_imap',
    sql: /* sql */ `
      -- A fourth kind: a user-supplied IMAP mailbox. The CHECK was declared
      -- inline in 0001_init, so it carries Postgres' default name.
      ALTER TABLE app.instances DROP CONSTRAINT instances_kind_check;
      ALTER TABLE app.instances ADD CONSTRAINT instances_kind_check
        CHECK (kind IN ('whatsapp', 'postgres', 'telegram', 'imap'));

      -- The mailbox's credentials. imap_password is a secret like dsn: plain,
      -- never projected. There is no plaintext transport — 'starttls' must
      -- upgrade or the connection is refused.
      ALTER TABLE app.instances
        ADD COLUMN imap_host     text NOT NULL DEFAULT '',
        ADD COLUMN imap_port     integer,
        ADD COLUMN imap_security text NOT NULL DEFAULT ''
          CHECK (imap_security IN ('', 'tls', 'starttls')),
        ADD COLUMN imap_user     text NOT NULL DEFAULT '',
        ADD COLUMN imap_password text NOT NULL DEFAULT '';

      -- What the sync knows about a mailbox. Headers only: bodies and
      -- attachments are fetched from the mail server when a tool asks, and are
      -- never written here. See server/utils/imap-sync.ts.
      --
      -- identity is lower(user@host): when new credentials name another
      -- mailbox, everything synced under the old one is deleted. lease_until is
      -- claimed by conditional UPDATE, so two replicas never sync one mailbox
      -- at once.
      CREATE TABLE app.mail_sync_state (
        instance_id     text PRIMARY KEY REFERENCES app.instances (id) ON DELETE CASCADE,
        identity        text NOT NULL DEFAULT '',
        lease_until     timestamptz NOT NULL DEFAULT '-infinity',
        runs            integer NOT NULL DEFAULT 0,
        last_attempt_at timestamptz,
        last_success_at timestamptz,
        last_error_code text,
        last_error_at   timestamptz,
        auth_failed     boolean NOT NULL DEFAULT false
      );

      -- One row per folder the server lists, synced or not, so a listing can
      -- say a folder exists and was skipped. oldest_uid is how far down the
      -- backfill has walked; backfill_stopped says why it stopped short of the
      -- folder's first message ('days' or 'count'), backfill_complete that it
      -- did not.
      CREATE TABLE app.mail_folders (
        instance_id       text NOT NULL REFERENCES app.instances (id) ON DELETE CASCADE,
        path              text NOT NULL,
        name              text NOT NULL DEFAULT '',
        delimiter         text,
        special_use       text,
        synced            boolean NOT NULL DEFAULT false,
        uidvalidity       bigint,
        last_uid          bigint NOT NULL DEFAULT 0,
        oldest_uid        bigint,
        highest_modseq    numeric,
        backfill_complete boolean NOT NULL DEFAULT false,
        backfill_stopped  text CHECK (backfill_stopped IN ('days', 'count')),
        server_messages   integer,
        last_synced_at    timestamptz,
        PRIMARY KEY (instance_id, path)
      );

      -- One row per message per folder. A message filed in two folders (a
      -- Gmail label) is two rows sharing message_id; cross-folder reads
      -- collapse them. text_part / html_part are BODYSTRUCTURE part ids, and
      -- attachments lists parts with name, type and size — the bytes stay on
      -- the mail server.
      CREATE TABLE app.mail_messages (
        instance_id     text NOT NULL REFERENCES app.instances (id) ON DELETE CASCADE,
        folder_path     text NOT NULL,
        uidvalidity     bigint NOT NULL,
        uid             bigint NOT NULL,
        message_id      text,
        in_reply_to     text,
        refs            text[] NOT NULL DEFAULT '{}',
        subject         text NOT NULL DEFAULT '',
        from_addr       jsonb NOT NULL DEFAULT '[]',
        to_addr         jsonb NOT NULL DEFAULT '[]',
        cc_addr         jsonb NOT NULL DEFAULT '[]',
        sent_at         timestamptz,
        received_at     timestamptz NOT NULL,
        flags           text[] NOT NULL DEFAULT '{}',
        size            integer,
        text_part       text,
        html_part       text,
        attachments     jsonb NOT NULL DEFAULT '[]',
        subject_tsv     tsvector GENERATED ALWAYS AS (to_tsvector('simple', subject)) STORED,
        PRIMARY KEY (instance_id, folder_path, uid),
        FOREIGN KEY (instance_id, folder_path) REFERENCES app.mail_folders (instance_id, path) ON DELETE CASCADE
      );
      CREATE INDEX mail_messages_received_idx ON app.mail_messages (instance_id, received_at DESC, uid DESC);
      CREATE INDEX mail_messages_message_id_idx ON app.mail_messages (instance_id, message_id);
      CREATE INDEX mail_messages_subject_idx ON app.mail_messages USING gin (subject_tsv);
    `,
  },
  {
    name: '0005_billing',
    sql: /* sql */ `
      -- Plans, for a deployment with NUXT_BILLING=stripe. Every column is
      -- inert when billing is off, which is every self-hosted deployment.
      --
      -- subscription_status is Stripe's own status, verbatim, as last read
      -- from Stripe — never from a webhook payload. An organization with none
      -- is on Free; see effectivePlan() in server/utils/billing.ts.
      -- trial_used survives the subscription, so cancelling and resubscribing
      -- does not buy a second trial. seats_billed is the quantity last pushed
      -- to the seat price, so the reconcile task can tell when it drifted.
      ALTER TABLE app.organizations
        ADD COLUMN stripe_customer_id     text,
        ADD COLUMN stripe_subscription_id text,
        ADD COLUMN subscription_status    text,
        ADD COLUMN trial_ends_at          timestamptz,
        ADD COLUMN current_period_end     timestamptz,
        ADD COLUMN cancel_at_period_end   boolean NOT NULL DEFAULT false,
        ADD COLUMN trial_used             boolean NOT NULL DEFAULT false,
        ADD COLUMN seats_billed           integer;
      CREATE UNIQUE INDEX organizations_stripe_customer_key
        ON app.organizations (stripe_customer_id) WHERE stripe_customer_id IS NOT NULL;

      -- The plan picked on the signup page, carried through verification so
      -- the verified signup can send the browser on to checkout. NULL for an
      -- invited signup, an email change, and any deployment without billing.
      ALTER TABLE app.email_verifications
        ADD COLUMN plan text CHECK (plan IN ('free', 'pro'));
    `,
  },
  {
    name: '0006_entitlements_and_hosted_events',
    sql: /* sql */ `
      -- What an organization may hold, as plain numbers. NULL is unlimited,
      -- which is every organization on a self-hosted deployment: nothing here
      -- names a plan or a payment provider. Whatever sells plans writes these
      -- (today stripe.ts, later the separate cloud service) and the web app
      -- only enforces them — see entitlements.ts. plan_label is for display.
      ALTER TABLE app.organizations
        ADD COLUMN max_connections integer CHECK (max_connections >= 0),
        ADD COLUMN max_tokens      integer CHECK (max_tokens >= 0),
        ADD COLUMN max_members     integer CHECK (max_members >= 1),
        ADD COLUMN plan_label      text;

      -- An outbox for the hosted offering: account and organization changes,
      -- and per-minute MCP usage rollups, for a separate service to turn into
      -- billing seats, CRM records and telemetry. Written only on a deployment
      -- that has the hosted offering configured (hosted-events.ts), so a
      -- self-hosted database never holds a row.
      --
      -- No foreign keys on purpose: an event outlives the organization or user
      -- it describes — "this org was deleted" is itself an event. Payloads
      -- never carry credentials, connection strings, chat ids, message content
      -- or tool arguments.
      CREATE TABLE app.hosted_events (
        id      bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        type    text NOT NULL,
        org     text,
        user_id text,
        payload jsonb NOT NULL DEFAULT '{}',
        created timestamptz NOT NULL DEFAULT now()
      );
    `,
  },
  {
    name: '0007_entitlement_defaults',
    sql: /* sql */ `
      -- The limits a new organization is born with on the hosted deployment,
      -- written by the cloud service (apps/cloud) at every boot. The web app
      -- reads it inside the signup transaction and refuses a hosted signup while
      -- it is missing, rather than create an organization with no limits. Empty
      -- on a self-hosted deployment, where nothing reads it.
      CREATE TABLE app.entitlement_defaults (
        id              text PRIMARY KEY CHECK (id = 'new_organization'),
        max_connections integer CHECK (max_connections >= 0),
        max_tokens      integer CHECK (max_tokens >= 0),
        max_members     integer CHECK (max_members >= 1),
        plan_label      text,
        updated         timestamptz NOT NULL DEFAULT now()
      );
    `,
  },
  {
    name: '0008_token_send_disclaimer',
    sql: /* sql */ `
      -- A line the send tools append to every message this token sends, so the
      -- people receiving them can tell they were sent through an assistant. NULL
      -- is off. Applied server-side in the send handlers rather than asked of
      -- the model, which could forget or reword it.
      ALTER TABLE app.mcp_tokens
        ADD COLUMN send_disclaimer text
          CHECK (send_disclaimer IS NULL OR length(send_disclaimer) BETWEEN 1 AND 200);
    `,
  },
  {
    name: '0009_marketing_consent',
    sql: /* sql */ `
      -- When the user ticked the marketing box on the hosted signup page. NULL is
      -- not given — every self-hosted user, every account from before the box,
      -- and everyone who left it unticked. Records consent given at signup, not
      -- current subscription state: an unsubscribe lives in the CRM (Brevo, fed
      -- by the cloud service), and nothing here reverses one.
      ALTER TABLE app.users
        ADD COLUMN marketing_consent_at timestamptz;

      -- The box's answer, carried through verification like plan.
      ALTER TABLE app.email_verifications
        ADD COLUMN marketing_consent boolean NOT NULL DEFAULT false;
    `,
  },
  {
    name: '0010_whatsapp_groups',
    sql: /* sql */ `
      -- The last successful answer from Evolution's fetchAllGroups for a
      -- WhatsApp connection, so a cold process (deploy, restart, another
      -- replica) and a disconnected account can still name groups. Evolution
      -- 2.3.7 keeps subjects only in memory, so nothing upstream can stand in.
      --
      -- Only what naming needs: subject and size. No picture URLs and no
      -- participants. Never copied into app.hosted_events, whose payloads must
      -- not carry chat ids or names.
      --
      -- Rows are the account's whole group list as of fetched_at: a successful
      -- refresh replaces them exactly, so a group the account left disappears.
      -- They cascade with the connection, which is removed only through
      -- deleteInstance() (instances.org is RESTRICT).
      CREATE TABLE app.whatsapp_groups (
        instance_id text NOT NULL REFERENCES app.instances (id) ON DELETE CASCADE,
        jid         text NOT NULL,
        subject     text,
        size        integer CHECK (size IS NULL OR size >= 0),
        fetched_at  timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (instance_id, jid)
      );
    `,
  },
  {
    name: '0011_whatsapp_group_scans',
    sql: /* sql */ `
      -- When each WhatsApp connection's group list was last fetched from
      -- WhatsApp, shared by every replica. One fetchAllGroups costs about two
      -- WhatsApp queries per group (Evolution answers the groups.update it
      -- triggers with a groupMetadata per group, then fetches every group's
      -- picture), and WhatsApp answers repeated runs with rate-overlimit. So a
      -- scan runs only when none succeeded within the scan interval and none
      -- failed within the back-off, and only by the replica holding the lease;
      -- everyone else names groups from app.whatsapp_groups.
      --
      -- lease_until is claimed by a conditional UPDATE, like mail_sync_state,
      -- so no database connection is held across the scan. NULL is free —
      -- not '-infinity', which the app pool's timestamp transform cannot
      -- turn into an ISO string.
      CREATE TABLE app.whatsapp_group_scans (
        instance_id text PRIMARY KEY REFERENCES app.instances (id) ON DELETE CASCADE,
        scanned_at  timestamptz,
        failed_at   timestamptz,
        lease_until timestamptz
      );
    `,
  },
  {
    name: '0012_mcp_token_clients',
    sql: /* sql */ `
      -- Which MCP clients have started a session with each connector token:
      -- the clientInfo and protocolVersion of every accepted initialize. One
      -- row per client per token, since one bearer token can be pasted into
      -- several clients at once and a single column would show only the last.
      --
      -- Every value is what the client chose to send. It is a support and
      -- leak hint, never identity: nothing may authorize on it. The lengths
      -- match the clipping in server/utils/mcp-clients.ts, which also keeps
      -- each token to its newest rows, so a holder sending a fresh name on
      -- every initialize cannot grow this without bound.
      --
      -- last_seen is the last session started, not the last tool call; that
      -- stays app.mcp_tokens.last_used_at. Rows cascade with the token.
      CREATE TABLE app.mcp_token_clients (
        token_id         text NOT NULL REFERENCES app.mcp_tokens (id) ON DELETE CASCADE,
        client_name      text NOT NULL CHECK (length(client_name) <= 100),
        client_version   text NOT NULL CHECK (length(client_version) <= 100),
        protocol_version text CHECK (length(protocol_version) <= 100),
        user_agent       text CHECK (length(user_agent) <= 200),
        first_seen       timestamptz NOT NULL DEFAULT now(),
        last_seen        timestamptz NOT NULL DEFAULT now(),
        sessions         integer NOT NULL DEFAULT 1 CHECK (sessions > 0),
        PRIMARY KEY (token_id, client_name, client_version)
      );
      CREATE INDEX mcp_token_clients_recent_idx
        ON app.mcp_token_clients (token_id, last_seen DESC);
    `,
  },
  {
    name: '0013_mcp_tool_calls',
    sql: /* sql */ `
      -- One row per MCP tool call, while the organization records them: which
      -- tool, whether it succeeded, the request's User-Agent, and the optional
      -- reason the model gave for the call. See server/utils/tool-calls.ts.
      --
      -- reason is model-written free text and can quote what the user asked
      -- about, so it is treated like a tool argument: kept here only, for 30
      -- days (the mcp:prune-tool-calls task), never copied into hosted_events.
      -- Self-reported throughout — nothing may authorize, bill or rate-limit on
      -- it. Lengths match the clipping in tool-calls.ts. Rows cascade with the
      -- token and the connection; neither cascade deletes anything upstream.
      CREATE TABLE app.mcp_tool_calls (
        id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        token_id   text NOT NULL REFERENCES app.mcp_tokens (id) ON DELETE CASCADE,
        instance   text NOT NULL REFERENCES app.instances (id) ON DELETE CASCADE,
        tool       text NOT NULL CHECK (length(tool) <= 100),
        ok         boolean NOT NULL,
        reason     text CHECK (length(reason) <= 300),
        user_agent text CHECK (length(user_agent) <= 200),
        at         timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX mcp_tool_calls_token_idx ON app.mcp_tool_calls (token_id, at DESC, id DESC);
      CREATE INDEX mcp_tool_calls_instance_idx ON app.mcp_tool_calls (instance);
      CREATE INDEX mcp_tool_calls_at_idx ON app.mcp_tool_calls (at);

      -- Whether calls are recorded. record_tool_calls is the organization's own
      -- choice, off by default. tool_calls_required is written only by the
      -- cloud service (on for Free on the hosted deployment) and, while true,
      -- overrides the choice and refuses changes to it. Self-hosted
      -- organizations never have it set. Like max_*, it outlives hosted mode:
      -- unsetting NUXT_CLOUD_URL leaves it as it was.
      ALTER TABLE app.organizations
        ADD COLUMN record_tool_calls   boolean NOT NULL DEFAULT false,
        ADD COLUMN tool_calls_required boolean NOT NULL DEFAULT false;
      ALTER TABLE app.entitlement_defaults
        ADD COLUMN tool_calls_required boolean NOT NULL DEFAULT false;
    `,
  },
  {
    name: '0014_instance_row_churn',
    sql: /* sql */ `
      -- A WhatsApp socket that keeps reopening: Evolution 2.3.7 retries a
      -- 440 (conflict: replaced) close at once, and two sockets on one set of
      -- credentials replace each other indefinitely while the column reads
      -- 'open'. Every open writes Evolution's "Instance" row, so an 'open' row
      -- written within the last two minutes, observed continuously for ten,
      -- is that loop. These hold the observation, written only by
      -- server/utils/alerts.ts: row_churn_since is the first evaluation that
      -- saw a recent write, row_churn_seen_at the latest. Both empty means no
      -- churn seen. Stored rather than in memory so replicas and restarts
      -- agree on how long it has lasted.
      ALTER TABLE app.instances
        ADD COLUMN row_churn_since   timestamptz,
        ADD COLUMN row_churn_seen_at timestamptz;
    `,
  },
  {
    name: '0015_instance_paired_at',
    sql: /* sql */ `
      -- WhatsApp only: when this app first saw the account linked (a live
      -- read answering 'open', or Evolution's row carrying an ownerJid).
      -- Written once and never cleared, so a logout later does not make a
      -- connection that was paired look like one nobody finished setting up.
      -- A connection with this still NULL an hour after it was created is
      -- deleted by the instances:reap-unpaired task, through deleteInstance().
      --
      -- reap_lease_until is that task's claim on a row, a conditional UPDATE
      -- like whatsapp_group_scans, so two replicas never both ask Evolution
      -- to delete one instance. NULL is free.
      ALTER TABLE app.instances
        ADD COLUMN paired_at        timestamptz,
        ADD COLUMN reap_lease_until timestamptz;

      -- Backfill: existing connections that were ever paired must not be
      -- reaped. now(), not the real moment, which nobody recorded. The task
      -- re-checks live before deleting anything, so what this misses is
      -- caught there; what it must never do is miss in the other direction.
      --
      -- Only the alert sweep writes down_since, and only for a paired
      -- connection; churn is seen only on an 'open' row; a group scan
      -- succeeds only over a live socket.
      UPDATE app.instances i
      SET paired_at = now()
      WHERE i.kind = 'whatsapp'
        AND (i.down_since IS NOT NULL
          OR i.alerted_at IS NOT NULL
          OR i.row_churn_since IS NOT NULL
          OR EXISTS (SELECT 1 FROM app.whatsapp_group_scans s
                     WHERE s.instance_id = i.id AND s.scanned_at IS NOT NULL));

      -- In the default deployment Evolution writes into this same database, so
      -- its own records say which accounts were linked: an ownerJid, or any
      -- stored message. Guarded three ways, because none of it is ours: the
      -- tables may not exist (a separate Evolution database), this role may
      -- not read them, and Evolution may change them. Any failure skips the
      -- backfill rather than failing the migration — and with it the boot.
      DO $$
      BEGIN
        IF to_regclass('public."Instance"') IS NOT NULL
           AND has_table_privilege('public."Instance"', 'SELECT') THEN
          UPDATE app.instances i
          SET paired_at = now()
          WHERE i.kind = 'whatsapp' AND i.paired_at IS NULL AND i.instance_id <> ''
            AND EXISTS (SELECT 1 FROM public."Instance" e
                        WHERE e.id = i.instance_id AND e."ownerJid" IS NOT NULL);
        END IF;
        IF to_regclass('public."Message"') IS NOT NULL
           AND has_table_privilege('public."Message"', 'SELECT') THEN
          UPDATE app.instances i
          SET paired_at = now()
          WHERE i.kind = 'whatsapp' AND i.paired_at IS NULL AND i.instance_id <> ''
            AND EXISTS (SELECT 1 FROM public."Message" m WHERE m."instanceId" = i.instance_id);
        END IF;
      EXCEPTION WHEN OTHERS THEN
        RAISE WARNING 'paired_at backfill from Evolution''s tables skipped: %', SQLERRM;
      END
      $$;
    `,
  },
  {
    name: '0016_instance_ops_alerted_at',
    sql: /* sql */ `
      -- WhatsApp only: the deployment's operator (NUXT_OPS_ALERT_EMAIL) has
      -- been mailed about this connection's current reconnect loop. Set by a
      -- conditional UPDATE before the mail goes out, so two replicas cannot
      -- both send it, and put back if the send fails; cleared once the loop
      -- has ended and the operator has been told so. Written only by
      -- server/utils/alerts.ts. NULL means no loop reported.
      ALTER TABLE app.instances
        ADD COLUMN ops_alerted_at timestamptz;
    `,
  },
  {
    name: '0017_instance_connect_hold',
    sql: /* sql */ `
      -- WhatsApp only: until when this app must not ask Evolution to connect
      -- this account (GET /instance/connect in state 'close'). Evolution
      -- 2.3.7 builds a new socket for that call and never ends the one it
      -- replaces, so a call landing while Evolution is reconnecting by itself
      -- (the restart WhatsApp asks for right after a QR scan) leaves two
      -- sockets on one set of credentials replacing each other until the
      -- service restarts (ju-li/automata-mcp#122). Pushed forward whenever
      -- the pairing poll sees the socket connecting or open, and claimed by a
      -- conditional UPDATE before every connect, so replicas and browser tabs
      -- share it. NULL means no hold. Written only by instances.ts.
      ALTER TABLE app.instances
        ADD COLUMN connect_hold_until timestamptz;
    `,
  },
  {
    name: '0018_totp_setup_bound',
    sql: /* sql */ `
      -- An unconfirmed authenticator secret is the password check at
      -- totp/setup carried forward to totp/confirm, which asks only for a
      -- session. So it is bound and bounded like a sign-in challenge: only
      -- the session that ran setup may confirm it (setup_session; a session
      -- ending clears it, and NULL never matches), within a short window
      -- from created, and attempts counts wrong codes, claimed before each
      -- is checked; the fifth deletes the secret. Rows left from before this
      -- carry no session and could never be confirmed, so they go now.
      ALTER TABLE app.totp_credentials
        ADD COLUMN attempts integer NOT NULL DEFAULT 0,
        ADD COLUMN setup_session text REFERENCES app.sessions (id) ON DELETE SET NULL;
      DELETE FROM app.totp_credentials WHERE confirmed_at IS NULL;
    `,
  },
  {
    name: '0019_whatsapp_group_scan_failures',
    sql: /* sql */ `
      -- Consecutive failed group scans since the last success. The back-off
      -- after a failure doubles with each one (1 h, 2 h, 4 h ... capped at a
      -- day), so an account whose scan never finishes stops costing
      -- WhatsApp a full scan every hour. A success resets it. Rows whose last event was a failure start
      -- at one, so they keep today's one-hour wait.
      ALTER TABLE app.whatsapp_group_scans
        ADD COLUMN failures integer NOT NULL DEFAULT 0 CHECK (failures >= 0);
      UPDATE app.whatsapp_group_scans
        SET failures = 1
        WHERE failed_at IS NOT NULL AND (scanned_at IS NULL OR failed_at > scanned_at);
    `,
  },
  {
    name: '0020_password_resets',
    sql: /* sql */ `
      -- A password reset waiting to be used: mailed to the account's address,
      -- either because someone asked on the "Forgot password?" page
      -- (requested_by 'self') or because an admin of the account's
      -- organization pressed the button on the Team page ('admin'). One per
      -- account: asking again replaces it.
      --
      -- link_hash is the SHA-256 of the token in the mailed link; code_hash of
      -- the row id and the six-digit code. attempts counts wrong codes,
      -- claimed before each is checked; the fifth deletes the row. email is
      -- the address the mail went to: the reset is spent only while the
      -- account still signs in with it, so a mail sitting in an address the
      -- account has since moved away from is dead. Written only by
      -- server/utils/password-reset.ts.
      CREATE TABLE app.password_resets (
        id           text PRIMARY KEY,
        user_id      text NOT NULL UNIQUE REFERENCES app.users (id) ON DELETE CASCADE,
        email        text NOT NULL,
        link_hash    text NOT NULL UNIQUE CHECK (length(link_hash) = 64),
        code_hash    text NOT NULL CHECK (length(code_hash) = 64),
        attempts     integer NOT NULL DEFAULT 0,
        requested_by text NOT NULL CHECK (requested_by IN ('self', 'admin')),
        expires_at   timestamptz NOT NULL,
        created      timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX password_resets_expires_idx ON app.password_resets (expires_at);
    `,
  },
  {
    name: '0021_whatsapp_group_lookups',
    sql: /* sql */ `
      -- Group names no longer come from fetchAllGroups (a groupMetadata per
      -- group, all at once: rate-overlimit bursts on large accounts, #175).
      -- They come from Evolution's "Chat".name, and app.whatsapp_groups now
      -- holds the answers of slow, one-group-at-a-time lookups instead of the
      -- account's whole list. A row per group looked up:
      --
      --   fetched_at  the last lookup that answered; subject and size are
      --               from it. NULL when every lookup of the group failed.
      --   checked_at  the last lookup, answered or not, which paces the next.
      --
      -- Existing rows are scan answers, so both dates start as fetched_at.
      ALTER TABLE app.whatsapp_groups
        ALTER COLUMN fetched_at DROP NOT NULL,
        ALTER COLUMN fetched_at DROP DEFAULT,
        ADD COLUMN checked_at timestamptz;
      UPDATE app.whatsapp_groups SET checked_at = fetched_at;
      ALTER TABLE app.whatsapp_groups
        ALTER COLUMN checked_at SET NOT NULL,
        ALTER COLUMN checked_at SET DEFAULT now();

      -- app.whatsapp_group_scans keeps its shape and becomes the per-account
      -- lease for lookup runs: scanned_at = the last run that got an answer,
      -- failed_at and failures = runs that got none, in a row.
    `,
  },
  {
    name: '0022_recent_history_only',
    sql: /* sql */ `
      -- Whether this organization may ask WhatsApp for an account's full
      -- history at pairing (Baileys' requireFullSync) for connections on the
      -- deployment's own Evolution server. A capability, not a plan: the cloud
      -- service sets it for Free, since a full import is most of the disk an
      -- account costs. false is no restriction — every self-hosted
      -- organization. Full history is opt-in for everyone ("Import full
      -- history" on the create form); this only locks that choice.
      --
      -- Read at create, by the dashboard's "Import full history" and before
      -- every pairing (whatsappHistoryLimited in instances.ts). It deletes
      -- nothing: history already imported stays.
      --
      -- IF NOT EXISTS: this shipped to preview databases as 0012 before main
      -- took that number, and those must not fail on the renamed copy.
      ALTER TABLE app.organizations
        ADD COLUMN IF NOT EXISTS recent_history_only boolean NOT NULL DEFAULT false;

      ALTER TABLE app.entitlement_defaults
        ADD COLUMN IF NOT EXISTS recent_history_only boolean NOT NULL DEFAULT false;
    `,
  },
  {
    name: '0023_whatsapp_group_gone',
    sql: /* sql */ `
      -- When WhatsApp last told a lookup that the account is not in this group
      -- (forbidden / item-not-found / not-authorized: left, removed, or the
      -- group deleted). Such a group is not looked up again for 30 days, and
      -- the refusal does not count toward the account's lookup back-off
      -- (#178). Cleared by the next lookup that answers. NULL for every
      -- existing row: none has been seen gone yet.
      ALTER TABLE app.whatsapp_groups ADD COLUMN gone_at timestamptz;
    `,
  },
  {
    name: '0024_instance_socket_dead_seen_at',
    sql: /* sql */ `
      -- WhatsApp only: when a call that needs the account's socket — a send, a
      -- group lookup — last failed with Evolution's dead-socket error
      -- ("Connection Closed"). Evolution's in-memory state can keep reading
      -- open over a socket that is gone (#205); this is the evidence that it
      -- is not. Written by socket-evidence.ts at most once a minute, cleared
      -- by the next socket call that succeeds, and judged in readStatus
      -- (instances.ts) against when Evolution last reopened the socket. NULL
      -- for every existing row: nothing has been seen yet.
      ALTER TABLE app.instances ADD COLUMN socket_dead_seen_at timestamptz;
    `,
  },
  {
    name: '0025_message_autovacuum',
    sql: /* sql */ `
      -- Evolution's "Message": vacuum often enough that the visibility map
      -- stays current, so per-account counts stay index-only (#156). At the
      -- default 20% insert threshold a freshly imported account paid a table
      -- read for nearly every row it counted. The values production has run
      -- since #156 (#208).
      --
      -- Not our table, so guarded like 0015 and never allowed to fail the
      -- boot: skipped when it doesn't exist here (Evolution on a separate
      -- database), when this role doesn't own it (ALTER TABLE ... SET needs
      -- ownership), or when its lock isn't free within 5 s — an index build
      -- or a manual VACUUM holds the same SHARE UPDATE EXCLUSIVE lock, and
      -- appDb() answers 503 to every tenant until migrations finish. A skip
      -- is a warning in the boot log; docs/whatsapp.md has the statement.
      --
      -- The lock itself blocks neither reads nor writes. lock_timeout is put
      -- back afterwards because every pending migration shares this
      -- transaction.
      DO $$
      DECLARE
        previous text := current_setting('lock_timeout');
      BEGIN
        IF to_regclass('public."Message"') IS NOT NULL
           AND pg_has_role((SELECT relowner FROM pg_class WHERE oid = to_regclass('public."Message"')), 'USAGE') THEN
          PERFORM set_config('lock_timeout', '5s', true);
          ALTER TABLE public."Message" SET (
            autovacuum_vacuum_insert_scale_factor = 0.01,
            autovacuum_vacuum_scale_factor = 0.05
          );
          PERFORM set_config('lock_timeout', previous, true);
        ELSE
          RAISE WARNING '"Message" vacuum settings skipped: table absent or not owned by %', current_user;
        END IF;
      EXCEPTION WHEN OTHERS THEN
        PERFORM set_config('lock_timeout', previous, true);
        RAISE WARNING '"Message" vacuum settings skipped: %', SQLERRM;
      END
      $$;
    `,
  },
]
