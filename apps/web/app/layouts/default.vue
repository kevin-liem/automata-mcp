<script setup lang="ts">
import { ChevronDownIcon, CircleUserIcon, CreditCardIcon, LogOutIcon, UserIcon, UsersIcon } from '@lucide/vue'

const { user, org, isAdmin, logout } = useSession()
// Undefined without billing, so a self-hosted header carries no plan at all.
const { plan, overLimit } = usePlan()
const hosted = useHosted()
</script>

<template>
  <div class="flex min-h-screen flex-col bg-background text-foreground">
    <header v-if="user" class="border-b">
      <div class="mx-auto flex h-14 max-w-5xl items-center justify-between gap-4 px-6">
        <div class="flex min-w-0 items-center gap-3">
          <NuxtLink to="/instances">
            <AppLogo />
          </NuxtLink>
          <!-- Which organization you are acting in. Everything on every page
               belongs to it, and with one organization per account there is no
               switcher — this is a label, not a control. -->
          <span v-if="org" class="hidden truncate border-l pl-3 text-sm text-muted-foreground sm:inline">
            {{ org.name }}
          </span>
        </div>

        <div class="flex items-center gap-3">
          <Button v-if="org && plan && isAdmin" as-child variant="ghost" size="sm">
            <NuxtLink to="/billing">
              <CreditCardIcon class="size-4" />
              <span class="hidden sm:inline">Billing</span>
            </NuxtLink>
          </Button>

          <Button v-if="org" as-child variant="ghost" size="sm">
            <NuxtLink to="/team">
              <UsersIcon class="size-4" />
              <span class="hidden sm:inline">Organization</span>
            </NuxtLink>
          </Button>

          <!-- The account menu. The icon is always there and the address is not:
               on a phone the header used to identify the signed-in account with
               nothing at all, because the email was the only marker and it was
               hidden below `sm`. The menu's own label carries it instead. -->
          <DropdownMenu>
            <DropdownMenuTrigger as-child>
              <Button variant="ghost" size="sm" class="max-w-[14rem]">
                <CircleUserIcon class="size-4" />
                <span class="hidden truncate sm:inline">{{ user.email }}</span>
                <ChevronDownIcon class="size-3 text-muted-foreground" />
              </Button>
            </DropdownMenuTrigger>

            <DropdownMenuContent align="end" class="w-56">
              <DropdownMenuLabel class="font-normal">
                <span v-if="user.name" class="block truncate">{{ user.name }}</span>
                <span class="block truncate text-xs font-normal text-muted-foreground">
                  {{ user.email }}
                </span>
              </DropdownMenuLabel>

              <DropdownMenuSeparator />

              <DropdownMenuItem as-child>
                <NuxtLink to="/profile">
                  <UserIcon class="size-4" />
                  Profile
                </NuxtLink>
              </DropdownMenuItem>

              <DropdownMenuSeparator />

              <DropdownMenuItem variant="destructive" @select="logout()">
                <LogOutIcon class="size-4" />
                Sign out
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
    </header>

    <!-- A lapsed organization still holding more than Free allows. Everyone
         sees it, since everyone's connectors but one have stopped; only an
         admin is pointed at the fix. -->
    <div v-if="user && overLimit" class="border-b border-amber-500/40 bg-amber-500/5">
      <p class="mx-auto max-w-5xl px-6 py-2 text-sm">
        This organization is over the Free plan's limits, so only one connector
        token is working.
        <NuxtLink v-if="isAdmin" to="/billing" class="underline underline-offset-4">
          Upgrade to Pro
        </NuxtLink>
        <template v-else>
          Ask an admin to upgrade.
        </template>
      </p>
    </div>

    <main class="mx-auto w-full max-w-5xl flex-1 px-6 py-10">
      <slot />
    </main>

    <!-- Hosted offering only: the footer holds nothing else yet, so a
         self-hosted deployment gets no empty bar. -->
    <footer v-if="hosted" class="border-t">
      <div class="mx-auto flex max-w-5xl justify-end px-6 py-4">
        <LegalLinks />
      </div>
    </footer>
  </div>
</template>
