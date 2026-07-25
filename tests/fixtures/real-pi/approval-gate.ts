/**
 * Real-Pi test extension. It turns a harmless marker command into an
 * interactive approval so the adapter's RPC extension UI bridge is exercised.
 */
export default function approvalGate(pi: any): void {
  pi.on("tool_call", async (event: any, ctx: any) => {
    if (event.toolName !== "bash") return undefined
    const command = typeof event.input?.command === "string" ? event.input.command : ""
    if (!command.includes("REAL_PI_APPROVAL_OK")) return undefined

    const approved = await ctx.ui.confirm(
      "Approve real PI tool call",
      `Allow this harmless test command?\n\n${command}`,
    )
    if (!approved) {
      return { block: true, reason: "Tool call denied by adapter test client" }
    }
    return undefined
  })
}
