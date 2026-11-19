# ShelfGuard Workspace Rules

## Local AI Evaluation (`eval:local`)

When running local shelf-display evaluations on `server/data/local-eval/` (e.g., `npm --prefix server run eval:local`):

1. **Single Run with Bounded Thinking Only**:
   - Run with `--runs 1` (`npm --prefix server run eval:local -- --runs 1`) using the default bounded thinking mode.
   - Do **not** run `--no-thinking` or compare thinking vs. non-thinking modes; output only one result per store.
2. **Mandatory 5-Dimension + Total Score Table**:
   - Test results presented to the user **must** include a Markdown table with:
     - Store folder ID (e.g., `store-01`)
     - Total score and rating level (`总分 / 评级`)
     - All 5 dimension scores: 排面数量 (`facingCount`)、黄金位置 (`goldenPosition`)、正标朝向 (`labelOrientation`)、价签规范 (`priceTag`)、横签露出 (`horizontalBanner`)
