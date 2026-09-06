import { describe, expect, it } from "vitest";

import {
  buildIncludesIndex,
  shapePaginatedPosts,
  shapePostResponse,
  shapePostsResponse,
  shapeUsersResponse,
} from "#/client/shape";

/** A realistic search response: quote, media, expanded URL, CJK, full metrics. */
const SEARCH_RESPONSE = {
  data: [
    {
      id: "1799000000000000001",
      text: "Shipping v2 today https://t.co/abc123 好い一日",
      created_at: "2026-07-18T09:14:02.000Z",
      author_id: "44196397",
      conversation_id: "1798000000000000009",
      lang: "en",
      public_metrics: {
        retweet_count: 12,
        reply_count: 3,
        like_count: 88,
        quote_count: 1,
        impression_count: 10400,
      },
      referenced_tweets: [{ type: "quoted", id: "1798000000000000009" }],
      entities: {
        urls: [
          {
            start: 18,
            end: 37,
            url: "https://t.co/abc123",
            expanded_url: "https://acme.dev/v2",
            display_url: "acme.dev/v2",
          },
        ],
      },
      attachments: { media_keys: ["3_1799000000000000002"] },
      edit_history_tweet_ids: ["1799000000000000001"],
    },
  ],
  includes: {
    users: [
      { id: "44196397", username: "mgcrea", name: "Olivier", verified: true },
      { id: "9999", username: "acme", name: "Acme Inc" },
    ],
    tweets: [
      {
        id: "1798000000000000009",
        text: "v1 was great.",
        author_id: "9999",
        created_at: "2026-07-17T10:00:00.000Z",
      },
    ],
    media: [
      {
        media_key: "3_1799000000000000002",
        type: "photo",
        url: "https://pbs.twimg.com/media/x.jpg",
        alt_text: "release notes screenshot",
      },
    ],
  },
  meta: { result_count: 1, next_token: "b26v89c19zqg8o3fpds1a2b3c4d" },
};

describe("shapePostsResponse", () => {
  it("flattens the whole envelope into readable posts", () => {
    expect(shapePostsResponse(SEARCH_RESPONSE)).toEqual({
      posts: [
        {
          id: "1799000000000000001",
          url: "https://x.com/mgcrea/status/1799000000000000001",
          author: "@mgcrea (Olivier)",
          created_at: "2026-07-18T09:14:02.000Z",
          text: "Shipping v2 today https://acme.dev/v2 好い一日",
          lang: "en",
          metrics: { likes: 88, reposts: 12, replies: 3, quotes: 1, views: 10400 },
          quotes: {
            id: "1798000000000000009",
            author: "@acme (Acme Inc)",
            text: "v1 was great.",
            created_at: "2026-07-17T10:00:00.000Z",
          },
          media: ["photo: https://pbs.twimg.com/media/x.jpg (alt: release notes screenshot)"],
          conversation_id: "1798000000000000009",
        },
      ],
      result_count: 1,
      next_token: "b26v89c19zqg8o3fpds1a2b3c4d",
    });
  });

  it("never leaks includes, entities, attachments or edit history", () => {
    const shaped = JSON.stringify(shapePostsResponse(SEARCH_RESPONSE));
    for (const leak of ["includes", "entities", "attachments", "edit_history", "author_id"]) {
      expect(shaped).not.toContain(leak);
    }
  });

  // Size is NOT the headline benefit, and pretending otherwise would set a
  // target that pushes out genuinely useful fields. Shaping adds a clickable
  // `url` and a readable `author` per post, which costs roughly what dropping
  // `author_id` and `edit_history_tweet_ids` saves. On a page of plain posts
  // sharing one author it is close to size-neutral; the win shows up when the
  // sidecar is rich (quotes, media, several authors), as below. The real
  // benefit is that the model never performs the author_id → includes.users
  // join, and so can never get it wrong.
  it("is meaningfully smaller when the response carries a real sidecar", () => {
    const raw = JSON.stringify(SEARCH_RESPONSE).length;
    const shaped = JSON.stringify(shapePostsResponse(SEARCH_RESPONSE)).length;
    expect(shaped).toBeLessThan(raw * 0.7);
  });
});

describe("URL expansion", () => {
  it("splices right-to-left so two URLs both land correctly", () => {
    const res = shapePostsResponse({
      data: [
        {
          id: "1",
          author_id: "u1",
          // Offsets are UTF-16 code units, matching String.slice. `end` is
          // exclusive: "https://t.co/aaa" occupies [4, 20).
          text: "see https://t.co/aaa and https://t.co/bbbbbbb end",
          entities: {
            urls: [
              { start: 4, end: 20, url: "https://t.co/aaa", expanded_url: "https://first.example" },
              {
                start: 25,
                end: 45,
                url: "https://t.co/bbbbbbb",
                expanded_url: "https://second.example/with/a/much/longer/path",
              },
            ],
          },
        },
      ],
      includes: { users: [{ id: "u1", username: "someone" }] },
    });
    expect(res.posts[0]?.text).toBe(
      "see https://first.example and https://second.example/with/a/much/longer/path end",
    );
  });

  it("leaves the text alone when offsets are out of range", () => {
    const res = shapePostsResponse({
      data: [
        {
          id: "1",
          text: "short",
          entities: { urls: [{ start: 0, end: 999, expanded_url: "https://x.example" }] },
        },
      ],
    });
    expect(res.posts[0]?.text).toBe("short");
  });
});

describe("graceful degradation", () => {
  it("degrades an unresolvable author instead of throwing", () => {
    const res = shapePostsResponse({
      data: [{ id: "1", text: "orphan", author_id: "44196397" }],
      includes: { users: [] },
    });
    expect(res.posts[0]?.author).toBe("@unknown (id 44196397)");
    // Still a working link — i/web is X's own canonical fallback.
    expect(res.posts[0]?.url).toBe("https://x.com/i/web/status/1");
  });

  it("returns just the id for a quoted post that is not sideloaded", () => {
    const res = shapePostsResponse({
      data: [
        {
          id: "1",
          text: "quoting something deleted",
          referenced_tweets: [{ type: "quoted", id: "999" }],
        },
      ],
    });
    expect(res.posts[0]?.quotes).toEqual({ id: "999" });
  });

  it("handles a response with no includes at all", () => {
    expect(() => shapePostsResponse({ data: [{ id: "1", text: "bare" }] })).not.toThrow();
  });

  it("omits metrics entirely when the fields were not requested", () => {
    const res = shapePostsResponse({ data: [{ id: "1", text: "bare" }] });
    expect(res.posts[0]).not.toHaveProperty("metrics");
  });
});

describe("retweets", () => {
  it("shows the original's text rather than the truncated RT prefix", () => {
    const res = shapePostsResponse({
      data: [
        {
          id: "1",
          author_id: "u1",
          text: "RT @author: the beginning of something longer that got cut o…",
          referenced_tweets: [{ type: "retweeted", id: "900" }],
        },
      ],
      includes: {
        users: [
          { id: "u1", username: "sharer" },
          { id: "u2", username: "author", name: "The Author" },
        ],
        tweets: [
          {
            id: "900",
            author_id: "u2",
            text: "the beginning of something longer that got cut off",
          },
        ],
      },
    });
    expect(res.posts[0]?.text).toBe("the beginning of something longer that got cut off");
    expect(res.posts[0]?.reposts?.author).toBe("@author (The Author)");
  });
});

describe("media", () => {
  it("uses the preview image for a video, which has no url field", () => {
    const res = shapePostsResponse({
      data: [{ id: "1", text: "clip", attachments: { media_keys: ["7_1"] } }],
      includes: {
        media: [{ media_key: "7_1", type: "video", preview_image_url: "https://p.jpg" }],
      },
    });
    expect(res.posts[0]?.media).toEqual(["video: https://p.jpg"]);
  });

  it("says so when a media key was not expanded", () => {
    const res = shapePostsResponse({
      data: [{ id: "1", text: "pic", attachments: { media_keys: ["3_1"] } }],
    });
    expect(res.posts[0]?.media).toEqual(["media (not expanded): 3_1"]);
  });
});

describe("partial failures", () => {
  it("surfaces ids X refused to return alongside a 200", () => {
    const res = shapePostsResponse({
      data: [{ id: "1", text: "ok" }],
      errors: [{ value: "2", title: "Not Found Error", resource_type: "tweet" }],
    });
    expect(res.posts).toHaveLength(1);
    expect(res.not_found).toEqual(["2"]);
  });

  it("explains an empty single-post lookup", () => {
    const res = shapePostResponse({ errors: [{ value: "123", title: "Not Found Error" }] });
    expect(res).toEqual({
      error:
        "X returned no post for id 123 — it is deleted, protected, or from a suspended account.",
    });
  });
});

describe("shapeUsersResponse", () => {
  it("flattens a profile with metrics", () => {
    const res = shapeUsersResponse({
      data: [
        {
          id: "44196397",
          username: "mgcrea",
          name: "Olivier",
          description: "builds things",
          verified: true,
          created_at: "2009-06-02T20:12:29.000Z",
          public_metrics: {
            followers_count: 1200,
            following_count: 300,
            tweet_count: 4200,
            listed_count: 15,
          },
        },
      ],
    });
    expect(res.users[0]).toEqual({
      id: "44196397",
      username: "mgcrea",
      name: "Olivier",
      url: "https://x.com/mgcrea",
      description: "builds things",
      verified: true,
      created_at: "2009-06-02T20:12:29.000Z",
      metrics: { followers: 1200, following: 300, posts: 4200, listed: 15 },
    });
  });

  it("accepts a single-object data payload as well as an array", () => {
    const res = shapeUsersResponse({ data: { id: "1", username: "solo" } });
    expect(res.users).toHaveLength(1);
  });
});

describe("buildIncludesIndex", () => {
  it("merges includes blocks from several pages", () => {
    const index = buildIncludesIndex([
      { users: [{ id: "1", username: "a" }] },
      { users: [{ id: "2", username: "b" }] },
    ]);
    expect(index.users.size).toBe(2);
  });

  it("tolerates a missing or malformed block", () => {
    const index = buildIncludesIndex([{ users: "not an array" } as never, {}]);
    expect(index.users.size).toBe(0);
  });
});

describe("shapePaginatedPosts", () => {
  it("resolves authors across page boundaries", () => {
    const res = shapePaginatedPosts({
      data: [
        { id: "1", text: "page one", author_id: "u2" },
        { id: "2", text: "page two", author_id: "u1" },
      ],
      includes: [
        { users: [{ id: "u1", username: "first" }] },
        { users: [{ id: "u2", username: "second" }] },
      ],
      nextToken: "cursor",
    });
    expect(res.posts[0]?.author).toBe("@second");
    expect(res.posts[1]?.author).toBe("@first");
    expect(res.next_token).toBe("cursor");
  });

  it("reports ids X refused across pages as not_found", () => {
    const res = shapePaginatedPosts({
      data: [{ id: "1", text: "kept" }],
      includes: [],
      errors: [{ value: "7", resource_type: "tweet" }, { resource_id: "8" }],
    });
    expect(res.not_found).toEqual(["7", "8"]);
  });
});
