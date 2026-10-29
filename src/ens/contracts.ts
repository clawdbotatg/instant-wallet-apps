import { concat, numberToHex, parseAbi, stringToBytes, toHex, zeroHash, type Address, type Hex } from "viem";

/*
 * ENS v2 on Ethereum mainnet (live since block 26,282,117, Oct 2026). Verified on chain — see README.
 * Registration is paid in USDC (no ETH value), and the records live in a per-name
 * PermissionedResolver proxy that the registrant deploys from the ENS VerifiableFactory.
 */
export const ENS_CHAIN = 1;
export const REGISTRAR: Address = "0xD6D8369e55c94Ae8AFA714E6cF7AB5bE54D5CC81"; // ETHRegistrar (v2)
export const RESOLVER_FACTORY: Address = "0x77510ba162dfeA3d8989E3f0928a691B345730D2"; // VerifiableFactory
export const RESOLVER_IMPL: Address = "0x565b0F456a04Ac9b48758190e90030623Cff57C5"; // PermissionedResolver implementation
export const REVERSE_REGISTRAR: Address = "0xa58E81fe9b61B5c3fE2AFD33CF304c454AbFc7Cb"; // owns addr.reverse
export const UNIVERSAL_RESOLVER: Address = "0xeEeEEEeE14D718C2B47D9923Deab1335E144EeEe";
export const USDC: Address = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
export const ZERO: Address = "0x0000000000000000000000000000000000000000";
export const NO_REFERRER: Hex = zeroHash;
/** Every resolver role to the owner — what the ENS app grants. */
export const ALL_ROLES = BigInt("0x" + "1".repeat(64));
export const YEAR = 365n * 24n * 60n * 60n;
export const COIN_ETH = 60n;

export const registrarAbi = parseAbi([
  "function isAvailable(string label) view returns (bool)",
  "function getRegisterPrice(string label, uint64 duration, address paymentToken) view returns (uint256 base, uint256 premium)",
  "function makeCommitment(string label, address owner, bytes32 secret, address subregistry, address resolver, uint64 duration, bytes32 referrer) pure returns (bytes32)",
  "function commit(bytes32 commitment)",
  "function commitmentAt(bytes32 commitment) view returns (uint64)",
  "function register(string label, address owner, bytes32 secret, address subregistry, address resolver, uint64 duration, address paymentToken, bytes32 referrer) returns (uint256 tokenId)",
  "function MIN_COMMITMENT_AGE() view returns (uint64)",
  "function MAX_COMMITMENT_AGE() view returns (uint64)",
]);

export const factoryAbi = parseAbi([
  "function predictProxyAddress(address sender, uint256 salt) view returns (address)",
  "function deployProxy(address implementation, uint256 salt, bytes data) returns (address)",
]);

export const resolverAbi = parseAbi([
  "struct Grant { address account; uint256 roleBitmap; }",
  "function initialize(Grant[] grants, bytes[] calls)",
  "function setAddress(bytes name, uint256 coinType, bytes addressBytes)",
]);

export const reverseAbi = parseAbi(["function setName(string name) returns (bytes32)"]);

export const universalAbi = parseAbi([
  "function reverse(bytes lookupAddress, uint256 coinType) view returns (string primary, address resolver, address reverseResolver)",
]);

export const erc20Abi = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
]);

/** DNS wire format of "<label>.eth" (what the v2 resolver keys records by). */
export function dnsName(label: string): Hex {
  const l = stringToBytes(label);
  if (l.length > 255) throw new Error("Name is too long");
  return concat([numberToHex(l.length, { size: 1 }), toHex(l), "0x03", toHex("eth"), "0x00"]);
}
