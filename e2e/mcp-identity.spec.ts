import { expect, test } from "@playwright/test";
import { accountForPayload } from "../server/src/mcp/auth.js";

// No browser and no server: this is the claim mapping behind the MCP endpoint.
// It is the only part of machine authentication this repo can test — a service
// token JWT is signed by Cloudflare, so nothing short of a real token reaches
// the endpoint with one. The payloads below are copied from Cloudflare's
// "Application token" documentation, which is what makes a wrong claim name
// fail here instead of in production.

const AGENT = "agent@example.com";
const CONFIG = { agentEmail: AGENT, serviceTokenId: "e367826f93b8d7.access" };

// Authenticated with an identity provider.
const PERSON = {
  aud: ["32eafc7626e974616deaf0dc3ce63d7bcbed58a2731e84d06bc3cdf1b53c4228"],
  email: "Person@Example.com",
  exp: 1659474457,
  iat: 1659474397,
  nbf: 1659474397,
  iss: "https://example.cloudflareaccess.com",
  type: "app",
  identity_nonce: "6ei69kawdKzMIAPF",
  sub: "7335d417-61da-459d-899c-0a01c76a2f94",
  country: "US",
};

// Authenticated with a service token: no email, an empty sub, and the Client ID
// in common_name.
const SERVICE_TOKEN = {
  aud: ["32eafc7626e974616deaf0dc3ce63d7bcbed58a2731e84d06bc3cdf1b53c4228"],
  exp: 1659474457,
  iat: 1659474397,
  nbf: 1659474397,
  iss: "https://example.cloudflareaccess.com",
  type: "app",
  sub: "",
  common_name: "e367826f93b8d7.access",
  service_token_id: "e367826f93b8d7.access",
  service_token_status: true,
};

test.describe("MCP identity mapping", () => {
  test("a person acts as themselves", () => {
    expect(accountForPayload(PERSON, CONFIG)).toBe("person@example.com");
  });

  test("the pinned service token acts as the configured account", () => {
    expect(accountForPayload(SERVICE_TOKEN, CONFIG)).toBe(AGENT);
  });

  test("another service token acts as nobody", () => {
    // The door does not open for machines merely because Access vouched for
    // them: the token has to be the one the operator named.
    expect(
      accountForPayload(
        { ...SERVICE_TOKEN, common_name: "1111111111111.access" },
        CONFIG,
      ),
    ).toBe("");
  });

  test("no service token opens the endpoint while no account is named", () => {
    // Refusing is the safe default; acting as an unnamed account is not a thing.
    expect(
      accountForPayload(SERVICE_TOKEN, { ...CONFIG, agentEmail: "" }),
    ).toBe("");
  });

  test("no service token opens the endpoint while the token is unpinned", () => {
    // Deliberately not "accept any token this organization issues": that would
    // widen the moment a second token is created.
    expect(
      accountForPayload(SERVICE_TOKEN, { ...CONFIG, serviceTokenId: "" }),
    ).toBe("");
  });

  test("a payload with an email is never remapped to the machine account", () => {
    // Certificates and other non-standard policies can carry both. The person's
    // own address wins, so a mapped agent account is never a side door.
    expect(
      accountForPayload(
        { ...SERVICE_TOKEN, email: "someone@example.com" },
        CONFIG,
      ),
    ).toBe("someone@example.com");
  });

  test("a payload with neither claim acts as nobody", () => {
    expect(accountForPayload({ sub: "abc" }, CONFIG)).toBe("");
  });
});
