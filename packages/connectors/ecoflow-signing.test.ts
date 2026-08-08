import { describe, expect, it } from "vitest";
import { buildSignatureBase, flattenParams, signPayload, signRequest } from "./ecoflow-signing";

/**
 * These vectors are copied from the official EcoFlow developer documentation,
 * "HTTP access steps" (steps 2 and 8). They are the contract: if EcoFlow changes
 * the algorithm, or a refactor breaks it, these fail before anything reaches
 * live hardware.
 */
describe("EcoFlow signature contract", () => {
  it("expands the documented nested payload exactly as published", () => {
    const documented = {
      name: "demo1",
      ids: [1, 2, 3],
      deviceInfo: { id: 1 },
      deviceList: [{ id: 1 }, { id: 2 }],
    };

    expect(flattenParams(documented).sort().join("&")).toBe(
      "deviceInfo.id=1&deviceList[0].id=1&deviceList[1].id=2&ids[0]=1&ids[1]=2&ids[2]=3&name=demo1",
    );
  });

  it("reproduces the documented signature base string", () => {
    const base = buildSignatureBase(
      { sn: "123456789", params: { cmdSet: 11, id: 24, eps: 0 } },
      { accessKey: "Fp4SvIprYSDPXtYJidEtUAd1o" },
      "345164",
      "1671171709428",
    );

    expect(base).toBe(
      "params.cmdSet=11&params.eps=0&params.id=24&sn=123456789" +
        "&accessKey=Fp4SvIprYSDPXtYJidEtUAd1o&nonce=345164&timestamp=1671171709428",
    );
  });

  it("reproduces the documented signature", () => {
    const headers = signRequest(
      { sn: "123456789", params: { cmdSet: 11, id: 24, eps: 0 } },
      { accessKey: "Fp4SvIprYSDPXtYJidEtUAd1o", secretKey: "WIbFEKre0s6sLnh4ei7SPUeYnptHG6V" },
      { nonce: "345164", timestamp: "1671171709428" },
    );

    expect(headers.sign).toBe("07c13b65e037faf3b153d51613638fa80003c4c38d2407379a7f52851af1473e");
    expect(headers.accessKey).toBe("Fp4SvIprYSDPXtYJidEtUAd1o");
    expect(headers.nonce).toBe("345164");
    expect(headers.timestamp).toBe("1671171709428");
  });

  it("signs parameterless requests without a leading separator", () => {
    // device/list and sign/certification take no parameters.
    const base = buildSignatureBase(undefined, { accessKey: "abc" }, "123456", "1671171709428");
    expect(base).toBe("accessKey=abc&nonce=123456&timestamp=1671171709428");
    expect(signPayload(base, "secret")).toMatch(/^[0-9a-f]{64}$/);
  });

  it("omits null and undefined members rather than signing the string 'null'", () => {
    expect(flattenParams({ a: 1, b: null, c: undefined })).toEqual(["a=1"]);
  });

  it("emits a six-digit nonce", () => {
    for (let i = 0; i < 200; i++) {
      expect(signRequest({}, { accessKey: "a", secretKey: "b" }).nonce).toMatch(/^\d{6}$/);
    }
  });
});
