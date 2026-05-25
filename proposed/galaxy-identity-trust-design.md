# stavR — Identity & Trust across the Galaxy

> **Status:** design exploration / proposal. Not a decision yet.
> **Written:** 2026-05-25; consolidated from the design conversation of the same
> day. External research current to mid-2026.
> **Feeds:** a rewrite of ADR-035 (federated stavR); supersedes the Phase-0
> relay-hub substrate decision; resolves the open operator-login question.
> **Scope:** how a participant identifies itself, how trust is earned, how the
> hub topology organises itself, how participants communicate, and how anyone
> stays anonymous who wants to — across five modes: single, multi, family,
> friends, global.

---

## 0. The question

> *"How can I identify myself in the galaxy — extremely secure, but with the
> galaxy never dependent on anything outside it?"*

Three hard constraints fall out of that sentence, and every choice below is
checked against them:

1. **Self-rooted.** Your identity is something you generate and hold. No
   "Sign in with Google / Microsoft / GitHub." No corporate identity
   provider. No public certificate authority you don't run.
2. **No outside dependency.** The galaxy keeps working — identity, trust,
   routing, messaging, the lot — with nothing reachable beyond it. No
   blockchain, no hosted service, no DNS you don't control on the critical
   path, **and no Tor or Tailscale-style overlay service.** WireGuard *the
   protocol* (a mesh you run yourself) is fine; Tor and Tailscale *the
   services* are not. The galaxy is its own small internet.
3. **Anonymity is a dial, not a default-off.** A participant who wants to be
   pseudonymous — or fully anonymous — must be able to, *without* losing the
   ability to prove they are allowed to do what they are doing.

"The galaxy" is the stavR network: today three bombardment daemons on one box;
tomorrow 4-5 of your own always-on nodes; later family, then friends, then —
if you choose — the open world. The model has to be **one model that survives
all five of those** without being rebuilt each time.

The good news, established below: the constraints are not exotic. The rest of
the world spent 2024-2026 arriving at almost exactly this shape — and two
signals confirm the hardest parts. Microsoft **retired** its blockchain-
anchored DID method (no ledger needed). And both MCP and A2A built an explicit
**public-vs-private** split into discovery (open vs closed galaxies is the
mainstream answer, not a fringe one).

---

## 1. What the rest of the world settled on (2025-2026)

Three research threads — big-tech/standards, the decentralized-identity world,
and the live state of the agent-interoperability protocols.

### 1.1 Big tech, standards, and the agent protocols

**MCP (Model Context Protocol).** The headline change: in **December 2025
Anthropic donated MCP to the Agentic AI Foundation (AAIF)** under the Linux
Foundation. MCP is no longer Anthropic-steered — it sits under neutral
governance alongside A2A, with AWS, Anthropic, Block, Bloomberg, Cloudflare,
Google, Microsoft and OpenAI as platinum members. The authorization model is
OAuth 2.1; audience-bound tokens (RFC 8707) mean a token minted for node A
cannot be replayed against node B; Client ID Metadata Documents let a client's
identity simply *be a URL it controls* — a registration authority you run
yourself. Adoption is effectively universal across Anthropic, OpenAI, Google
and Microsoft.

**A2A (Agent2Agent).** Donated to the Linux Foundation June 2025, now also
under AAIF — the two former rivals share a home. v1.0 shipped early 2026;
later revisions add **signed Agent Cards** (a JSON profile, JWS-signed,
verifiable with public-key crypto and no central registry). 150+ organisations,
shipping in Azure AI Foundry, Amazon Bedrock and Google Cloud.

**MCP vs A2A** — settled as **complementary**, a two-layer stack: MCP is the
vertical axis (agent-to-tool), A2A the horizontal axis (agent-to-agent). The
"protocol war" dissipated once both landed under the same foundation.

**The public/private split — the validation of open vs closed galaxies.**
This matters most. The official **MCP Registry** (preview, Sept 2025) is for
*public* servers only — it states plainly it "does not support private
servers," and the documented pattern is to run **your own private subregistry,
entirely unlisted**, with no push to any index. A2A defines **three discovery
modes**: a published `.well-known` URL for public agents; *curated registries*
(public or private, with selective disclosure — different Agent Cards to
different callers); and fully private/direct discovery — and A2A explicitly
says private discovery "is not a problem the protocol needs to solve." So the
whole industry built exactly the open/closed distinction this design uses, and
built "private" as *don't-publish*, not as a network-layer trick.

**Microsoft.** *Entra Agent ID* gives agents a governed identity — but as an
object inside *your Entra tenant*, reachable only when Microsoft's cloud is up.
Excluded by constraint #1. The instructive part: Microsoft **retired
`did:ion`**, its Bitcoin-anchored DID method. The richest identity team in the
industry concluded a public ledger was unnecessary.

**GitHub.** The most useful *pattern* in the survey: short-lived OIDC tokens
whose claims are the identity; artifact attestations on **Sigstore** (ephemeral
identity → short-lived signing certificate → tamper-evident transparency log,
verified offline). "Prove you *are* this identity," not "prove you *hold* this
key." stavR already uses Sigstore for the Governor; it is self-hostable.

**RFC 9421 — HTTP Message Signatures.** The most mature dependency-free
building block: an actor signs its HTTP requests with an Ed25519 key; the
verifier checks pure crypto — no IdP, no CA, no ledger. The right wire-level
mechanism for node-to-node request authentication.

**AGNTCY / Internet of Agents** (Cisco → Linux Foundation) — an
infrastructure-layer effort: "DNS for agents," agent identity, and a secure
low-latency messaging layer. Complementary; worth tracking, not adopting.

**OWASP Non-Human Identity Top 10** (2025) — the red-team checklist: improper
offboarding, secret leakage, overprivileged accounts, long-lived credentials.

### 1.2 Decentralized / self-sovereign identity

**Decentralized Identifiers (DIDs).** A DID resolves to a document of public
keys and endpoints. The methods differ in what they depend on:

- **`did:key`** — the identifier *is* the public key; derived from the string
  itself, no network. Permanent, un-rotatable. Good for ephemeral subjects.
- **`did:peer`** — built for **pairwise private relationships**; generated
  locally, handed to one counterparty, resolvable only inside that
  relationship. Supports rotation via a local append-only signed log. The
  natural fit for a node-to-node mesh.
- **`did:web`** — a JSON document at an HTTPS path. No blockchain, but leans
  on DNS + TLS.
- **`did:webvh`** — `did:web` plus a **self-certifying identifier** (the id is
  a hash of the genesis key, so DNS takeover cannot forge it) and a
  **hash-chained, signed change log** giving rotation and tamper-evident
  history **without a ledger**. The log can be served by your own hub.

**Verifiable Credentials (VC 2.0)** — a W3C Recommendation, May 2025. Signed
claims: issuer → holder → verifier. **Selective disclosure** (SD-JWT VC; BBS+)
lets a holder reveal one claim — "is a family member," "is over 18" — without
the rest, or even their name. Verification is offline: check the issuer's
signature against a cached key; check revocation against a cached status list.

**Nostr** — the closest existing system to the galaxy. Identity is a bare
keypair — the public key *is* the account. Content is signed JSON events.
**Relays** are dumb store-and-forward servers: they cannot forge anything
(every event is signed) and confer no trust — you use several and route around
any that misbehave. Modern Nostr messaging (NIP-17 + NIP-44 + NIP-59
"gift wrap") hides content, sender, timestamp and message type from the relay.
Trust is computed from the **follow/vouch graph** — a quantitative gradient,
not a yes/no. This is the architecture of "hubs that relay and are not
trusted."

**Bitcoin** — the proof, at planetary scale, that **a keypair alone is a
complete identity**: no account, no registry, no authority; possession of the
private key *is* control; a signature is self-validating. Bitcoin also models
the anonymity move — a fresh, deterministically-derived address per
transaction — the direct analogue of a pairwise DID per relationship. And
multisig (2-of-3 etc.) is the direct analogue of threshold vouching (§2.4).

**Web-of-trust, and its scar tissue.** PGP's web-of-trust collapsed: an
unauthenticated, append-only keyserver network let anyone poison any key. The
lesson is not "trust graphs fail" — Nostr's works — it is "a trust graph must
be authenticated, scored, and evaluated locally, with no global append-only
dumping ground." **TOFU** (trust-on-first-use, the SSH model) is the humble
complement: pin a key on first contact, scream if it ever changes.

**Petnames and Zooko's Triangle.** A name cannot be all of human-meaningful,
secure-against-impersonation, and globally-unique — pick two. The 2025 Spritely
Institute paper resolves it by **splitting naming into layers**: **petnames**
are local private names you assign; **edge names** are names you assign *and
share*, rendered to others as transitive paths (`Kenneth ⇒ Erik ⇒ Maja`).
Layered over cryptographic identifiers, a user gets all three properties and
never sees a raw key.

**SPKI/SDSI and object-capabilities.** The deepest idea, and the one stavR is
already half-built on: **bind authority to a key, not to an identity.** An
authorization certificate says `<this key, may do X, may delegate, until
when>`. Authority is an unforgeable, attenuable, revocable, delegable
*capability*. The SPKI RFC states it outright: *"the user can remain anonymous
while exercising strongly verified authorization."* That sentence is how
anonymity and security stop being in tension.

**MLS (RFC 9420) and DIDComm v2** — two mature end-to-end-encrypted messaging
protocols. MLS gives forward secrecy and post-compromise security for groups
of any size, scales logarithmically, and is **transport-agnostic — it rides
over relays**. DIDComm v2 is the identity-native counterpart, with anonymous
and authenticated modes and mediator hops that hide endpoints.

### 1.3 The convergence

Strip away the branding and every serious 2025-2026 design says the same five
things:

1. **Identity is a keypair you generate and hold.** Not an account.
2. **No ledger.** Verifiable *history* is hash-chained signed logs, not a
   chain. (Microsoft's `did:ion` retirement is the headstone.)
3. **Trust is a separate, computed layer** — never a property of the identity.
4. **Authority, not identity, gates actions.** You can be anonymous and still
   provably authorized.
5. **Discovery has a public *and* a private mode.** Published registries are
   opt-in catalogues; private/unlisted discovery is a first-class, documented
   pattern. Open and closed galaxies are the mainstream shape.

stavR already embodies #1 in part (device keys), #3 and #4 substantially (the
capability model, trust scopes, the 4-tier action model). The galaxy design is
mostly **unifying and naming what exists**, plus the new pieces: a single root
of identity, a human-naming layer, a self-organising hub mesh, and a
communication fabric.

---

## 2. The spine — one identity model for the whole galaxy

Mode-independent. True in single mode and still true in global mode. The
modes (§5) only change *policy* on top of it.

### 2.1 Identity is a key you hold — the Seal

Every participant — you, each family member, each friend, each stranger — is,
at root, **one keypair they generated themselves, offline, that never leaves
their control.** That is the whole of identity. Bitcoin and Nostr prove it is
enough.

Your root keypair gets a name here: **the Seal** (working name — yours to
settle; it suits the rune / Lex-Insculpta theme — a seal is a mark of
authority pressed into everything you authorize). The Seal is:

- **Generated once, offline, on hardware you trust.** It is the single
  irreplaceable secret of your galaxy — backed up like a Bitcoin seed:
  offline, redundant, ideally split.
- **Never used directly day-to-day.** Its only job is to *certify subordinate
  keys*. Each node and each device (laptop, phone) gets its **own** keypair,
  and the Seal signs a short SPKI/SDSI-style certificate: "this key is mine,
  may do X, until Y." This is stavR's existing device-pairing, given a root.
- **Rotatable.** Expressed as a `did:webvh`-style identifier — a
  self-certifying id plus a hash-chained signed log — you can rotate the key
  and revoke a compromised device without changing your identity. The log
  lives on *your* hub. No ledger, no outside party.

A lost laptop is a revoked certificate, not a lost identity. A compromised
node is contained. A participant who is **not** you holds their own Seal:
self-sovereign means your galaxy never owns anyone else's identity — it only
decides what their key is *allowed to do* (§2.2).

### 2.2 Trust is not identity

The hinge of the design, and the answer to *"if I see someone on a hub, how
do I trust them."*

A verified key tells you **one thing only: messages from it are authentic and
unforged.** "Cryptographically verified" and "trusted" are different words on
purpose. Trust is a **separate layer** — computed, graded, revocable — with
four inputs a participant accumulates over time:

- **Capabilities** — the object-capability core. A key is granted specific,
  scoped, expiring, revocable, attenuable authority. Authority is the
  capability, not the identity. This is stavR's trust-scope model — it exists.
- **Vouches (web-of-trust)** — an existing trusted member signs "I vouch for
  this key." Trust flows along the graph as a *score* that decays with social
  distance — Nostr's model, not PGP's.
- **Verifiable credentials** — a signed attestation from an issuer you trust:
  "family member," "friend since 2026." Checked offline, selectively
  disclosable.
- **TOFU + history** — first contact is pinned; thereafter what the key *did*
  is in the hash-chained transparency log (§4.3, §4.5). A long clean history
  outweighs a fresh key. A fresh key is worth nothing — the Sybil defence,
  free of charge.

**The hub is not in this list.** A hub relays traffic; being "on a hub" is
evidence of nothing. A newcomer is a verified key with zero trust until one of
the four inputs gives them some.

### 2.3 Naming — petnames, never raw keys

You will never read a public key or a DID. The galaxy uses the petname split:
**petnames** are the private names *you* assign ("Erik's laptop," "Hub-Cabin")
— your galaxy's contact list; **edge names** are names a member assigns *and
shares*, so someone met through Erik shows up as the path `Erik ⇒ Maja` —
human-readable provenance, transitively rendered, borrowed from SPKI/SDSI
linked local names; **self-proposed names** are what a key calls itself —
shown, but always marked unverified. Under the hood, keys; on the surface,
petnames. A petname binds to a key only after the key is verified (§2.4), so
it cannot be hijacked.

### 2.4 Joining a hub — and threshold vouching

When a new key appears at a hub, trust is established by one of four paths,
strongest first:

1. **Invite capability.** Someone with authority mints a one-time, scoped,
   expiring invite (a signed capability) and hands it over out-of-band.
   Redeeming it proves "someone allowed to invite *did* invite this key."
   The invite also carries a **bootstrap hub address** so the newcomer has an
   entry point into the mesh (§3.3).
2. **Vouch / introduction.** An existing trusted member signs an edge-name
   introduction. The newcomer inherits a web-of-trust score along that path.
3. **Verifiable credential.** The newcomer presents a VC from an issuer you
   already trust. Checked offline.
4. **TOFU + out-of-band confirmation.** Accept the key on first contact, then
   confirm a short safety-number over a channel you already trust, and assign
   a petname. The SSH / Signal-safety-number model — the fallback.

In every case **the hub decides nothing.** Trust is decided by you, or by a
member you delegated that authority to.

**Threshold vouching (K-of-N).** A hub's *admission policy* is itself just a
rule, and a strong one is "a join requires **K independent vouches** from
members above trust tier T." Mechanically: each vouch is a small VC signed by
a different member's key; the hub's "admit" capability activates only when it
sees K distinct valid vouches. It is the same construction as a Bitcoin 2-of-3
multisig — applied to people. Three properties make it work:

- **Independence.** Require the K vouchers to be genuinely distinct, and
  ideally not all downstream of a single member — so one captured sub-tree
  cannot manufacture admissions.
- **Accountability.** A vouch carries the voucher's name into the transparency
  log. If the newcomer misbehaves, the vouch chain is visible and the
  voucher's *own* trust score takes the hit. Skin in the game is what stops
  members rubber-stamping each other.
- **Per-tier thresholds.** Joining as a read-only observer might need one
  vouch; joining with real capabilities, two or three. The hub sets its own K.

### 2.5 Anonymity as a dial

Anonymity falls out of the primitives, and it is *per-relationship*:

- **Pseudonymous by default.** A keypair carries no real-world identity.
- **Pairwise identifiers.** Present a different `did:peer` to each counterparty
  and each hub — no two can collude to correlate you. Bitcoin's
  fresh-address-per-transaction, applied to identity.
- **Selective disclosure.** Prove one property — "is a family member,"
  "vouched by Kenneth" — via SD-JWT / BBS+ without revealing anything else.
- **Authority without identity.** The SPKI promise: hold and exercise a
  capability while revealing nothing about who you are.
- **Metadata-hiding messages.** Gift-wrap / anoncrypt + mediator routing hide
  *who is talking to whom* (§4.5).

Anonymity never costs security: an anonymous participant is still a verified
key exercising explicit authority.

---

## 3. The hub mesh — topology and availability

The galaxy should behave like the internet: no fixed map, no central
authority, paths that emerge and re-form. This section is how.

### 3.1 One node type — stavr + hub

There is **no peer/hub split.** Every stavR node ships as *both* — the daemon
(the "stavr" part) and a hub-candidate (the relay part). There is no separate
"install a hub" step and no separate hub product. You start the galaxy with
your node, which is stavr-and-hub; a friend joins with one node, which is also
stavr-and-hub. Whether a given node *actively* carries relay load for others
is a **role it takes on**, not a separate identity — and the role is dynamic.

### 3.2 Emergent hubs — the fitness score and gossip

A node "becomes" a load-bearing hub the way an internet backbone router does:
not by election, but by being **capable and therefore chosen**.

Each node continuously measures itself and its neighbours and **gossips** a
**hub-fitness score** built from observable signals:

- **Reachability** — can other nodes actually open a connection *to* it. The
  hard gate (§3.3).
- **Uptime / availability** — the dominant factor. A laptop online four hours
  a day is a poor hub; an always-on NAS is a good one.
- **Capacity** — spare disk (for the mailbox and blobs), bandwidth, CPU.
- **Reliability** — historical: was it reachable when expected, did it drop
  traffic.
- **Network position** — latency to other members.

Scores propagate by **gossip** (an epidemic protocol — each node tells a few
others what it knows; the view converges in O(log n) rounds, the way Cassandra
or Consul disseminate membership). Every node then **locally** computes its own
ranking of hubs and picks which to route through — exactly as BGP routers each
compute their own best paths from exchanged reachability, with no central map.

**Promotion is not a vote — it is emergent use.** A node becomes a hub because
enough peers, independently, chose it. Demotion is just as soft: if it
degrades, peers quietly stop picking it and route elsewhere. Routing is
dynamic; a message from A to B follows whatever good hub both can currently
reach, and re-routes around any failure. **More nodes genuinely means more
resilient** — every node is a potential path.

A hub role can be handed out freely because **a hub is a blind relay** — it
carries end-to-end-encrypted traffic it cannot read (§4.5). Promoting a node
to hub gives it a *job*, never *trust*: **hub-ness ≠ trust.** That property is
what makes the dynamic model safe; if hubs were trusted, the role could never
be allowed to float.

### 3.3 The NAT reality — structured emergence

Physics gets a vote. On the real internet most consumer machines — laptops,
many desktops, anything behind carrier-grade NAT — **cannot accept inbound
connections.** A node behind a hard NAT can have perfect uptime and still be
useless as a hub, because nobody can connect *to* it. So "every node is a
hub-candidate" is true in software and false in practice for most home
machines. **Reachability is the first, hard filter** in the fitness score, and
for many friends' machines it is simply false. Hole-punching (STUN/ICE) rescues
*some* NATs, not symmetric NAT or CGNAT.

This is why Skype's pure-emergent supernode network eventually had to be
backstopped — a 2010 cascade took down ~40% of its supernodes at once, and the
supernode tier was later moved onto deliberate managed servers. The lesson is
not "don't do emergent hubs" — it is **structured emergence, not anarchy:**

- Deliberately run **one or two stable, reachable anchors** as the floor —
  your always-on, port-forwarded Synologys. They are the bootstrap entry
  points and the always-available mailbox of last resort.
- Let the dynamic mesh of opportunistic hubs grow **on top of** that floor,
  from whatever other reachable machines join.

The galaxy never falls through the floor, and it still grows, routes around
failure, and strengthens with every node — it simply acknowledges that the set
of *capable* hubs is constrained by reachability. A new node also needs one
known address to enter the mesh at all — which is why the invite capability
(§2.4) carries a bootstrap hub address.

### 3.4 What must be stable — three tiers

- **Identity is always stable.** The Seal is a key, not a process — it is "up"
  by definition, even with every machine off.
- **Hubs must be stable.** At least one always-on, reachable hub per galaxy:
  the fixed rendezvous and the encrypted mailbox. You have this — the
  Synologys.
- **Peers churn freely.** Friends' machines coming up and going down is
  *expected and normal*, absorbed entirely by async store-and-forward (§4.1).
  A friend offline just means their mail waits at a hub.

### 3.5 Open vs closed galaxies

A galaxy is open or closed based on **whether you publish it** — a directory
choice, not a network technology, and emphatically not Tor.

- **Closed galaxy.** Its hubs appear in no directory. To reach one you need
  the hub's address plus an invite, both handed over out-of-band. Even on the
  open internet, an unlisted hub that cryptographically rejects every
  un-invited key is effectively invisible — a scanner who stumbles onto the IP
  gets nothing. *Unlisted + cryptographically gated* is the whole mechanism.
  Reachable over plain TLS on the open internet, or over a WireGuard mesh you
  operate yourself.
- **Open galaxy.** Publishes its hubs (and optionally member Seals) into a
  directory — a "global address book of Seals." Anyone can find it and attempt
  to join under its admission policy (which may still be threshold vouching).

This is exactly how MCP and A2A handle public vs private (§1.1): the public
registry is opt-in, private discovery is unlisted and out-of-band. The
Tor-free way to be invisible is *don't publish it + gate it cryptographically*.
The honest trade of skipping Tor/mixnets: no resistance to a *global* network
observer doing traffic-correlation. For a personal/family/friends galaxy that
is the right trade, and it keeps the galaxy genuinely self-contained.

---

## 4. Communication

The hubs are relays; a relay that carries signed events is also a messaging
bus — so the galaxy gets its communication fabric almost for free, and that
fabric is also where trust operations (vouches, invites, credential
presentations, approval requests) travel.

### 4.1 Async store-and-forward

The model is **email's store-and-forward shape — but end-to-end encrypted, and
the mail server is blind.** You write to a friend (pick their petname from your
friend list, or look up a Seal in the global address book). Your node encrypts
the message end-to-end for their Seal and hands the bundle to a hub you both
reach. The hub stores it — it cannot read it, and with gift-wrap cannot even
see who it is for. The friend's node, next time it is online, collects and
decrypts. Both online → near-instant. Friend offline → it waits at the hub.
Same path either way. *This is how peer churn (§3.4) is absorbed* — an offline
friend is just mail waiting in a mailbox.

### 4.2 Files — content-addressed blobs

Small files ride inside the encrypted message. Large files use
**content-addressed encrypted blobs** (already in the federation design): the
file is encrypted and stored as a hash-named blob on a hub; the message
carries only the hash plus the decryption key. The recipient fetches the blob
by hash and decrypts; the hash self-verifies integrity. The hub holds
ciphertext blobs it cannot read, under a disk quota and retention policy you
set — that is the "file capacity."

### 4.3 Seal-signed receipts

Delivery and read receipts — and because every participant holds a Seal (a
signing key), a galaxy receipt is **cryptographically signed and
non-repudiable**, not the soft, fakeable thing email and the old messengers
had. Three states:

- **Sent** → **Delivered**: the recipient's node received the message and
  returns a small event — "message ⟨hash⟩ delivered at ⟨time⟩" — signed by the
  recipient's Seal.
- **Delivered** → **Opened**: the recipient actually viewed it; another
  Seal-signed event carries the timestamp.

That signature is the **"seal mark"** — a receipt nobody can forge and the
recipient cannot later deny; it can append to the transparency log. One caveat:
receipts leak *when* you read things, so they are the **recipient's choice**
(as in Signal) — delivered-receipts cheap and on by default, read-receipts
opt-in. Consistent with anonymity-as-a-dial.

### 4.4 Real-time — voice and chat

**Live text chat** is just the async fabric running hot — instant when both
are online; add presence ("online now") and typing indicators as small live
signals.

**Voice and video** need a low-latency media path, and media must *not* be
relayed through a hub. The answer is **WebRTC**: the two peers connect
*directly*, media flows peer-to-peer and is encrypted (WebRTC mandates
DTLS-SRTP). The hub's only job is **signaling** — helping the peers find each
other and exchange connection setup; once connected the hub is out of the media
path. For home routers, WebRTC uses STUN to discover public addresses and TURN
to relay when a direct connection cannot form — and crucially **your hub can be
the STUN/TURN server itself**, so even the fallback stays inside the galaxy,
with no external service (and even relayed media stays DTLS-SRTP-encrypted —
the hub relays ciphertext).

So a hub does triple duty: encrypted mailbox (async), signaling rendezvous
(real-time), and fallback media relay. Small group calls work mesh-style;
larger groups would later want a Selective Forwarding Unit, which a hub can
host.

### 4.5 The three encryption layers

Encrypted, yes — but there are **two layers you need together**, plus a third
concern:

- **Transport** — the wire. TLS 1.3, or the Noise protocol (what WireGuard and
  Lightning use). Defeats a passive wiretap; gives mandatory forward secrecy.
  Because the galaxy already has keypairs, the transport authenticates with the
  *galaxy's own keys* (mutual TLS or Noise keyed off the Seal chain) — **no
  public certificate authority** anywhere on the path.
- **Payload** — end-to-end encryption (MLS / DIDComm / the NIP-44 primitive).
  The sender encrypts for the recipient's key; only they can read it.

The trap: **TLS is hop-by-hop, not end-to-end.** Traffic going client → hub →
node is two separate TLS sessions, and the hub *terminates* TLS — it sees
plaintext in the middle. TLS alone would let a curious hub read everything.
That is why the payload is encrypted end-to-end *on top of* TLS, so the hub —
which does terminate the transport — still sees only ciphertext. Belt and
suspenders; *skärp och hängslen*. Nothing in the galaxy is ever plaintext on
the wire; the only cleartext is inside a node's own process.

### 4.6 The visibility ladder

"Extremely non-visible" is a spectrum, and cost climbs steeply per rung:

1. **Content hidden** — E2E encryption. Cheap; default.
2. **Metadata hidden from the relay** — gift-wrap / anoncrypt + mediator
   routing. The hub sees "a blob arrived, a blob left," not who↔who.
   Cheap-ish; default-able.
3. **Metadata hidden from a network observer** — padding to fixed sizes, cover
   traffic so silence is uninformative, multi-hop routing. Real cost in
   bandwidth and latency.
4. **Existence hidden** — no public IP, no DNS: nodes only on a self-run
   WireGuard mesh, or simply unlisted + cryptographically gated (§3.5).

Rung 4 is reached **without Tor** — unlisted + gated, optionally a WireGuard
mesh you operate. The honest limit: skipping Tor/mixnets means no rung-3
resistance to a *global* passive adversary. And rungs 3-4 pull *against* open
mode — an invisible galaxy has no public surface for strangers to find. That
is fine; it is a dial, and it means rungs 3-4 fit single/multi/family/friends
better than global.

---

## 5. The five modes

Same spine, same hub mesh, same fabric in every mode. What changes is the
**admission policy**, the **default anonymity posture**, and the **messaging
scope**. One system with a dial, not five systems.

| Mode | Who | Identity | Trust comes from | Default anonymity | Messaging |
|---|---|---|---|---|---|
| Single | just you, one node | the Seal (seed only) | loopback = you | n/a | self-notify |
| Multi | you, 4-5 nodes | Seal + device/node keys | Seal's delegation chain | n/a | operator ⇄ nodes |
| Family | + family | each holds own Seal | invite + family VC + capabilities | low (known by petname) | family MLS group |
| Friends | + friends | each holds own Seal | vouch / K-of-N + web-of-trust | optional pseudonymity | friend groups |
| Global | + anyone | sovereign keypairs | capabilities + WoT score + history | maximal, default | public relays |

The through-line: **as the galaxy widens you rely less on identity and more on
earned trust** — capabilities, vouches, history. Identity is constant; trust
gets more earned.

**Single** — one node, only you. Identity is near-vestigial (loopback already
means the operator), but single mode's one real job is to **generate the Seal
properly and back it up.** Get this wrong and nothing later recovers it.

**Multi** — your 4-5 always-on nodes; everything still yours, simply many keys.
The Seal certifies each node and device; every node carries the Seal's public
key as its root of trust. This is the **federated-identity answer without an
external IdP** — the Seal *is* the identity provider, and you hold it.

**Family** — each member generates their own Seal; your Seal issues each a
"family" VC plus capabilities scoped to what they may touch. Joining is by
one-time invite capability. The family is an MLS group. You keep the Layer-0
master switch; each member is still identity-sovereign.

**Friends** — each friend holds their own Seal; joins by invite or by
**threshold vouching** (§2.4). Capabilities are narrower than family's.
Anonymity becomes a real choice — a friend may participate pseudonymously,
presenting a vouch and a capability and nothing else.

**Global** — everyone is a sovereign keypair and that is *all* you assume. A
stranger gets **zero ambient authority** — only what an explicit capability
grants. Web-of-trust scores them; no path to your trust roots → score ~0 →
bearer-capability access only. The transparency log makes even an anonymous
key's actions attributable *to that key*. Optional, and the far end of the
dial — but reaching it needs **no rebuild**, only opened admission policy.

---

## 6. What stavR already has, and what is missing

**Already built — reuse as-is:** the capability / trust-scope model (the §2.2
trust layer); the 4-tier action model and the Layer-0 master switch; device
pairing + bearer tokens (subordinate keys, today without a named root); the
WebAuthn passkey ceremony; the hash-chained event store (ADR-036 — this is the
transparency log); Sigstore in the Governor path; relay hubs (Phase-0
substrate decision).

**Designed, not proven:** ADR-035 federation (A2A + OAuth 2.1) — cross-machine
federation has never worked end-to-end. This document supersedes its identity
half.

**Genuinely new — five pieces:**

1. **The Seal** — a single self-sovereign *root* tying device pairing, the
   passkey, and federation trust into one spine.
2. **The petname / edge-name layer** — human naming over keys.
3. **The self-organising hub mesh** — one node type, emergent hubs, gossiped
   fitness, dynamic routing. This *evolves* the Phase-0 substrate decision
   from pre-designated relay hubs to emergent ones.
4. **The communication fabric** — async store-and-forward, content-addressed
   blobs, Seal-signed receipts, WebRTC real-time.
5. **Threshold vouching** — K-of-N accountable admission.

Roughly two-thirds is renaming and wiring together what stavR holds; one-third
is new build, and the new build is well-specified by existing standards.

---

## 7. This answers the "login" question

The earlier question — how does the operator log in across 4-5 nodes — and its
A/B/C options dissolve here:

- **You do not "log in" to a node.** You prove you hold a **Seal-certified
  device key.** The device key lives in the OS keychain / secure enclave; the
  **passkey / biometric unlocks it**; the device key signs the request (RFC
  9421 HTTP Message Signature); the node verifies the signature against the
  Seal's delegation chain it already trusts. One gesture, real session, every
  node, no external IdP.
- Earlier **option C** (federated identity) was right — the Seal makes it work
  without a corporate IdP. **Option B** (passkey + session) is not a rival; it
  is the *unlock* for the device key. **Option A** (tunnel-to-loopback) keeps
  one honest job: the bootstrap / break-glass path.
- The **loopback dashboard gate** resolves cleanly: a node treats a valid
  Seal-chain request over the galaxy fabric exactly as a loopback caller —
  because it provably *is* the operator. The socat relay stays as the
  zero-trust-needed local convenience and break-glass route.

---

## 8. Wire-level — the concrete protocols

- **Root identity:** a self-generated Ed25519 keypair, expressed as
  `did:webvh` — self-certifying id + hash-chained signed log, served from your
  hub. Rotatable, no ledger.
- **Per-relationship identity:** `did:peer` — pairwise, unlinkable.
- **Ephemeral / session subjects:** `did:key` — deterministic, offline.
- **Subordinate-key certification:** SPKI/SDSI authorization certificates
  signed by the Seal.
- **Request authentication:** RFC 9421 HTTP Message Signatures, Ed25519.
- **Transport:** TLS 1.3 or Noise, mutually authenticated with galaxy keys —
  no public CA.
- **Hub discovery + fitness:** a gossip / epidemic protocol carrying
  hub-fitness scores; each node ranks and routes locally.
- **Node / client metadata:** MCP Client ID Metadata Documents and JWS-signed
  A2A Agent Cards — each node serves its own.
- **Attestations (roles, vouches):** W3C Verifiable Credentials 2.0; selective
  disclosure via SD-JWT VC and BBS+.
- **Messaging:** DIDComm v2 (1:1) and MLS / RFC 9420 (groups), over the hubs;
  content-addressed encrypted blobs for large files.
- **Real-time:** WebRTC (DTLS-SRTP), hub as signaling + self-hosted STUN/TURN.
- **Transparency / audit:** the hash-chained signed event log (ADR-036
  generalised; the Sigstore/Rekor pattern), self-hosted.
- **Operator presence:** WebAuthn passkey unlocking the keychain-held device
  key.

Every one of these is offline-capable and free of any outside authority. The
only "infrastructure" the galaxy needs is your own hubs.

---

## 9. Recommendation and next step

The design is internally coherent and standards-grounded, but it is a
proposal, not a decision. Before any build:

1. **A focused 10-3-1 on build order** — not *whether* (the spine is sound)
   but *what first*. Obvious sequence: the Seal + subordinate-key
   certification (unblocks login and multi mode) → the hub mesh + gossip → the
   petname layer → the communication fabric → per-mode admission policy.
   Family/friends/global are policy on a finished spine.
2. **A rewrite of ADR-035**, and an amendment to the Phase-0 substrate
   decision (pre-designated hubs → emergent hubs). This document is the input;
   the rewritten ADR becomes the decision of record.

Open questions, each a candidate mini-10-3-1: the **name** of the root
identity ("Seal" is a working name); whether the root is `did:webvh` or a pure
`did:peer` mesh; whether **global mode** is ever in scope (a values decision —
it changes how much transparency-log and Sybil machinery is worth building);
and **recovery** — how the Seal is backed up, and whether social recovery
(family vouching to reconstruct a lost Seal) is wanted.

Nothing here should be built without an explicit go-ahead and an ADR.

---

## 10. Sources

External research, gathered 2026-05-25 (current to mid-2026):

- MCP — spec (2025-11-25; 2026-07-28 RC), MCP Registry, donation to the
  Agentic AI Foundation / Linux Foundation (Dec 2025): modelcontextprotocol.io ;
  blog.modelcontextprotocol.io ; linuxfoundation.org ; anthropic.com
- A2A — Linux Foundation project (June 2025), v1.0+, signed Agent Cards,
  discovery modes: a2a-protocol.org ; linuxfoundation.org
- AGNTCY / Internet of Agents (Cisco → Linux Foundation): linuxfoundation.org
- Microsoft Entra Agent ID; `did:ion` retirement: learn.microsoft.com
- GitHub Artifact Attestations + Sigstore (Fulcio / Rekor / Cosign):
  docs.github.com ; blog.sigstore.dev
- HTTP Message Signatures (RFC 9421); Web Bot Auth: datatracker.ietf.org ;
  blog.cloudflare.com
- OWASP Non-Human Identity Top 10 (2025): owasp.org
- W3C DID Core; `did:key`, `did:peer`, `did:webvh`: w3.org/TR ;
  identity.foundation
- W3C Verifiable Credentials 2.0 (Rec. May 2025); SD-JWT VC; BBS+:
  w3.org/TR/vc-data-model-2.0 ; datatracker.ietf.org
- Nostr protocol + NIPs (01/05/17/44/59/65, NIP-EE / Marmot): nips.nostr.com
- Bitcoin keypair / address / multisig model: en.bitcoin.it ;
  learnmeabitcoin.com
- PGP web-of-trust failure analysis: inversegravity.net
- "Petnames: A humane approach to secure, decentralized naming" — Lemmer-Webber
  & Mark Miller, Spritely Institute, rev. April 2025: files.spritely.institute
- SPKI/SDSI; object-capability security: theworld.com/~cme ; en.wikipedia.org
- MLS — RFC 9420; architecture RFC 9750: datatracker.ietf.org
- DIDComm Messaging v2 (DIF): identity.foundation
- Super-peer / supernode architecture and the Skype supernode history;
  gossip / epidemic protocols; WebRTC (DTLS-SRTP, STUN/TURN/ICE): general
  distributed-systems references.

