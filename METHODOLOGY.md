## How Models Are Compared

Writing quality is evaluated through pairwise blind judging. For each prompt, an LLM judge is shown two writing samples labeled "Sample A" and "Sample B" with no indication of which model produced which text. The judge decides which sample is better (A, B, or tie) and provides reasoning.

Each prompt defines its own judging criteria tailored to the genre. A sermon prompt might specify theological accuracy and pastoral warmth, while a short story prompt might focus on narrative voice and character interiority. The judge evaluates against all listed criteria holistically.

Judging uses structured JSON output (a Zod schema requesting winner and reasoning). If a judge model does not support structured output, the system falls back to free-text generation and extracts JSON from the response.

### Position Bias Mitigation

LLMs can exhibit position bias — a tendency to favor whichever sample appears first. To counteract this, the benchmark randomly swaps the presentation order of each pair with 50% probability. After the judge responds, the winner is mapped back to the canonical ordering. This ensures that any position preference cancels out over many comparisons.

## The Benchmark Pipeline

The benchmark uses a pull-based adaptive architecture. Instead of generating all pairwise judgments upfront ($O(n^2)$ model pairs), the system uses confidence intervals to decide what work to do next, stopping as soon as ratings are sufficiently precise.

### Phase 1: Cache Seeding

Before making any API calls, the runner exhaustively scans the disk cache and loads all previously computed artifacts: writing samples, feedback, revisions, and judgments. This populates the rating model at zero cost and ensures no redundant work is repeated.

### Phase 2: Adaptive Pull Loop

The system iterates: compute Whole History Rating with confidence intervals → identify the model pair and judgment type whose data would most reduce uncertainty → generate only that work → repeat until convergence. By default, convergence requires that no model's CI overlaps any other model's CI across all three rating dimensions. Use `--confidence N` to instead converge when all CIs are below $\pm N$ Elo points.

When a judgment is needed, the system cascades through dependencies automatically. For example, requesting an improvement judgment triggers writing the initial sample, generating feedback, and producing the revision if any of those are missing. This ensure-cascade pattern means the system only creates artifacts that are actually needed to reduce rating uncertainty.

### Judgment Types

1. **Initial** — Pairwise blind comparison of initial writing outputs. Measures raw writing quality.
2. **Improvement** — Each revision is compared against its own original to measure whether the feedback actually helped. This determines feedback quality ratings.
3. **Revised** — Revised outputs are compared head-to-head, scoped by feedback source. Measures revised writing quality.

### Information-Gain Scoring

The need identifier scores candidate judgments by expected information gain:

$$\text{score} = \frac{(\sigma_A^2 + \sigma_B^2) \cdot p \cdot (1-p)}{1+N}$$

where $\sigma$ is each model's CI half-width, $p$ is the predicted win probability, and $N$ is the maximum output index in the comparison. Pairs with high uncertainty and close predicted strength score highest. Improvement and revised judgments receive cascade cost discounts (0.25 and 0.2 respectively) since they require additional prerequisite API calls. The depth penalty $\frac{1}{1+N}$ ensures breadth-first exploration: all prompts are covered at each output index before the system generates additional outputs for any single prompt.

## Whole History Rating System

Within each run, ratings are computed using Whole History Rating (WHR), a Bayesian extension of the Bradley-Terry model. WHR uses Newton's method to find the maximum a posteriori (MAP) estimate of model strengths, producing both point estimates and confidence intervals. These CIs drive the adaptive loop's stopping criterion.

### The Algorithm

Each model is assigned a log-strength parameter $r$ (initially 0). The algorithm maximizes the log-posterior:

$$\log P(\mathbf{r} \mid \text{data}) = \sum_{i < j} \bigl[ w_{ij} \log \sigma(r_i - r_j) + w_{ji} \log \sigma(r_j - r_i) \bigr] - \sum_i \frac{r_i^2}{2\sigma^2}$$

where $\sigma^2 = 0.25$ is the Gaussian prior variance. The Newton update solves $(-H)\,\Delta = g$ and applies $\mathbf{r} \leftarrow \mathbf{r} + \Delta$, repeating until convergence ($\max|\Delta| < 10^{-6}$, up to 50 iterations). Ratings are then centered by subtracting the mean.

The Gaussian prior ($\sigma^2 = 0.25$) regularizes the optimization, preventing divergence when a model wins or loses all games. This replaces the geometric-mean normalization used in standard Bradley-Terry and ensures symmetric, well-defined confidence intervals.

### Confidence Intervals

95% confidence intervals are derived from the diagonal of the inverse Hessian (the observed Fisher information). The CI half-width for model $i$ is:

$$\text{CI}_{95} = 1.96 \cdot \sqrt{(-H)^{-1}_{ii}} \cdot \frac{400}{\ln 10}$$

Wider CIs indicate less certainty; the adaptive loop targets the model pair that would most efficiently reduce the largest CI.

### ELO-Scale Conversion

Log-strengths are converted to a familiar ELO-like scale:

$$\text{rating} = \operatorname{round}\!\left(r \cdot \frac{400}{\ln 10} + 1500\right)$$

A 400-point gap corresponds to roughly 10:1 expected win odds. The baseline is 1500.

## Three Rating Dimensions

The adaptive loop tracks three independent rating dimensions, each of which must converge before the run completes:

### Writing ELO

Direct head-to-head writing quality from initial stage judgments. Two writing samples for the same prompt are shown to a judge; the winning model gets credit.

### Feedback ELO

How useful a model's editorial feedback is, measured indirectly. The system does not compare feedback texts directly. Instead, it uses improvement judgments (revision vs. original) to determine whether feedback led to a better revision.

The algorithm groups improvement judgments by prompt, judge, and original sample, so that feedback providers are only compared when tested on the same base text. Within each group, it pairs up different feedback providers. If feedback model A's revision beat the original but feedback model B's did not, A wins. If both improved or both failed, it's a tie. These synthetic pairwise outcomes are then fed into the same WHR computation.

### Revised Writing ELO

Revised outputs are compared head-to-head, scoped by feedback source so the comparison isolates writing ability from feedback quality. This uses the same WHR computation as initial writing.

### Per-Tag ELO

Each prompt has genre tags (e.g. "speech", "theological", "creative"). Per-tag ratings run the same WHR computation restricted to judgments from prompts with a given tag. This reveals category-specific strengths — a model might excel at essays but struggle with creative fiction.

## Cumulative Ratings

Ratings accumulate across multiple benchmark runs. The cumulative system uses the same WHR algorithm as per-run ratings, storing pairwise records: for each pair of models, the total number of wins for each side and ties.

When a new run completes, its pairwise outcomes are merged with the existing accumulated records. Ratings are then recomputed from scratch using WHR on the full merged dataset. This means the order in which runs are processed does not affect the final ratings.

Both the leaderboard on the dashboard page (cumulative ratings) and individual run pages use WHR ratings with confidence intervals.

## Reading the Results

- **1500** is the baseline rating. A model at the mean of all model strengths sits at 1500.
- **400-point gap** corresponds to roughly 10:1 expected win odds. A model rated 1900 is expected to beat a 1500-rated model about 90% of the time.
- **$\pm$CI** is the 95% confidence interval half-width in Elo points, derived from the Hessian of the WHR log-posterior. Smaller values indicate more precise ratings.
- **W / L / T** are raw win, loss, and tie counts from all pairwise matches the model participated in.
- **Matches** is the total number of pairwise comparisons involving the model (W + L + T). More matches produce more reliable ratings.

> The adaptive runner stops collecting judgments once all models are distinguishable (no CI overlaps). Use `--confidence N` to instead stop when all CIs are below $\pm N$ Elo points.
