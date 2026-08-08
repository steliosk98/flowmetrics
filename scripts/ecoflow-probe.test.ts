import { describe, expect, it } from "vitest";
import { flatten, signedHeaders } from "./ecoflow-probe.mjs";
import { flattenParams, signRequest } from "../packages/connectors/ecoflow-signing";

/**
 * The probe script re-implements signing so it can run with bare `node`, with no
 * build step and no node_modules. That duplication is only safe if it is held to
 * the same contract, so it is checked against both EcoFlow's published test
 * vector and the implementation the server actually uses.
 */
describe("ecoflow-probe signing stays in sync", () => {
  const params = { sn: "123456789", params: { cmdSet: 11, id: 24, eps: 0 } };
  const credentials = { accessKey: "Fp4SvIprYSDPXtYJidEtUAd1o", secretKey: "WIbFEKre0s6sLnh4ei7SPUeYnptHG6V" };

  it("matches the official documented signature", () => {
    const headers = signedHeaders(params, credentials.accessKey, credentials.secretKey, {
      nonce: "345164",
      timestamp: "1671171709428",
    });
    expect(headers.sign).toBe("07c13b65e037faf3b153d51613638fa80003c4c38d2407379a7f52851af1473e");
  });

  it("agrees with the server-side implementation", () => {
    const fromProbe = signedHeaders(params, credentials.accessKey, credentials.secretKey, {
      nonce: "424242",
      timestamp: "1700000000000",
    });
    const fromServer = signRequest(params, credentials, { nonce: "424242", timestamp: "1700000000000" });
    expect(fromProbe.sign).toBe(fromServer.sign);
  });

  it("flattens nested payloads identically", () => {
    const payload = { name: "demo1", ids: [1, 2, 3], deviceInfo: { id: 1 }, deviceList: [{ id: 1 }, { id: 2 }] };
    expect(flatten(payload).sort()).toEqual(flattenParams(payload).sort());
  });
});
