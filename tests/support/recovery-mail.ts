/** Read an actual native Auth recovery email from this stack's Mailpit. */
export async function capturedRecoveryEmail(mailpit: string | URL, email: string) {
  for (let attempt = 0; attempt < 50; attempt++) {
    const listing = await (await fetch(new URL(`/api/v1/search?query=${encodeURIComponent(`to:${email}`)}`, mailpit))).json() as { messages: { ID: string }[] };
    const messageId = listing.messages[0]?.ID;
    if (messageId) {
      const message = await (await fetch(new URL(`/api/v1/message/${messageId}`, mailpit))).json() as { HTML: string };
      const href = [...message.HTML.matchAll(/href="([^"]+)"/g)].map(match => match[1].replaceAll("&amp;", "&"))
        .find(value => value.includes("/password/reset"));
      if (!href) throw new Error("Native recovery email lacks its application link");
      const url = new URL(href);
      const parameters = new URLSearchParams(url.hash.slice(1));
      return { url, requestToken: parameters.get("request") ?? "", tokenHash: parameters.get("token_hash") ?? "", html: message.HTML };
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error("Native recovery email did not reach Mailpit");
}
