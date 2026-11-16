// Email addresses masked for screen sharing and streams: each keeps the
// first letter of its name and of its domain, and the domain's ending, so
// accounts still tell apart while the address does not show. Pure.
import { AccountView, NextView, Notice, PoolView, Report } from "@slopmax/client"

const email = /([A-Za-z0-9._%+-])[A-Za-z0-9._%+-]*@([A-Za-z0-9-])[A-Za-z0-9.-]*(\.[A-Za-z]{2,})\b/g

/** `ana@studio.dev` as `a•••@s•••.dev`, wherever an address shows in `text`. */
export const maskEmails = (text: string): string => text.replace(email, "$1•••@$2•••$3")

/** The report with every address masked: account names and emails, and the nudges' words. */
export const maskReport = (report: Report): Report =>
  new Report({
    ...report,
    accounts: report.accounts.map((account) => {
      const { email: address, ...rest } = account
      return new AccountView({
        ...rest,
        name: maskEmails(account.name),
        ...(address === undefined ? {} : { email: maskEmails(address) }),
      })
    }),
    pools: report.pools.map((pool) =>
      pool.next === undefined
        ? pool
        : new PoolView({ ...pool, next: new NextView({ ...pool.next, why: maskEmails(pool.next.why) }) }),
    ),
    nudges: report.nudges.map(
      (notice) =>
        new Notice({
          ...notice,
          message: maskEmails(notice.message),
          ...(notice.account === undefined ? {} : { account: maskEmails(notice.account) }),
        }),
    ),
  })
