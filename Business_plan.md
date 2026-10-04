# Business Plan

**Iressa · October 2026**

---

## 1. Executive summary

Cancer is one of the world's leading causes of death, and targeted cancer drugs usually stop working because the tumour evolves resistance. Iressa is a 3D simulator of cancer evolution, calibrated on public lab data. It models how a tumour grows, mutates and responds to treatment, cell by cell, and a custom reinforcement learning agent searches for effective treatment strategies. Researchers can test treatment schedules in minutes before spending months in the lab.

It now covers two cancers: EGFR-mutant lung cancer (calibrated and validated) and ER-positive breast cancer (research version). The AI agent learns a treatment pattern in under a minute and ranks it against standard strategies. Researchers sign in with email or ORCID.

Iressa is built mainly for researchers. We partner with research labs and universities, and they pay yearly licences for the hosted platform, validated models, support and calibration to their own data. Industry pilots for biotech and pharma come later as a second revenue stream.

## 2. Problem

Treating cancer is still a gamble. Every tumour is made of many cell families, and each can respond to a drug differently. Under treatment, a few cells survive by mutating and become resistant to the drug. Those cells then take over, the tumour grows back, and the treatment stops working. Nobody can predict in advance which path a tumour will take.

- Cancer caused about 9.7 million deaths in 2022 ([GLOBOCAN 2022](https://www.wcrf.org/preventing-cancer/cancer-statistics/worldwide-cancer-data/)).
- Targeted pills for EGFR lung cancer work at first, then usually fail. In the [FLAURA trial](https://www.nejm.org/doi/full/10.1056/NEJMoa1713137), median progression-free survival was 10.2 months with gefitinib or erlotinib and 18.9 months with osimertinib. These are trial medians, not predicted failure times for an individual patient.
- The same pattern appears in the most common breast cancer. In one [observational study of advanced breast cancer](https://pmc.ncbi.nlm.nih.gov/articles/PMC4998737/), ESR1 mutations were found in 16 of 44 patients (36%) first exposed to aromatase inhibitors in the metastatic setting. This is a small, selected cohort, not a population-wide rate. [SERENA-6](https://www.nejm.org/doi/full/10.1056/NEJMoa2502929) tested switching treatment once an emerging ESR1 mutation was detected.
- Doctors see a scan every 2–3 months, never the cell families competing inside.
- Testing a new dose, schedule or combination in the lab takes weeks to months per experiment, and bespoke simulation work needs programmers or a consulting contract. The time and cost Iressa could save still need to be confirmed with users.

## 3. Solution / Product

Iressa is a 3D simulator of cancer evolution. It models how a tumour grows, mutates and responds to treatment, and it uses a custom reinforcement learning agent to search for effective treatment strategies. Researchers can quickly test different evolutionary scenarios and drug regimens in silico, and they can inspect the full state of the simulation at every step: which clones exist, why each cell is alive or dying, and when resistance emerges. This helps them choose which experiments are worth running in the lab.

Public repository **[github.com/SborJ/Iressa](https://github.com/SborJ/Iressa)**; live at **[iressa.quicx.dev](https://iressa.quicx.dev/)**. Built and working at the hackathon:

| Part | What it gives the researcher |
|---|---|
| 3D tumour viewer | A tumour grown cell by cell with blood vessels, oxygen and drug. Cut it open, switch between tissue, fluorescence and histology views, and hover any cell to see why it is alive, resting or dying. |
| Calibrated engine | Cancer cell types and drug responses calibrated on public data (GDSC2, Cell Model Passports, CIViC, cBioPortal). Every rule lives in an editable data file. |
| Validation report | Data audited with checksums, solvers checked, 20 runs per schedule, sensitivity analysis. Verdict: pass with listed limitations. |
| Experiment controls | Compare treatment schedules (continuous, switching, adaptive) in the interface. Modelled exposure is capped at literature-based human-tolerable levels, with a warning when a request is held back. These are not patient-specific safety or prescribing limits. |
| Breast cancer model (research version) | ER-positive, HER2-negative breast cancer on the same engine: aromatase inhibitor, CDK4/6 inhibitor (palbociclib) and receptor-destroying drugs (fulvestrant, elacestrant); ESR1-mutant and CDK4/6-escape clones; early- vs late-switch strategies. |
| AI agent | One button adds an agent that learns a treatment pattern in 15–60 seconds, plays it on an unseen tumour, explains each decision in plain language and ranks it against the standard strategies. A deeper research layer (PPO) is also included. |
| Research accounts | Sign-in with email or ORCID (the researcher ID used in science), password reset and researcher profiles. The landing page is public; the simulator opens after sign-in. |
| Website | Landing page at the root of the site, simulator at `/simulation`. |

**Proof points so far:** the lung engine reproduces the known clinical order of resistance (EGFR → T790M → C797S/MET); in the breast model, switching drugs early leaves a much smaller tumour than switching late (first 5-tumour experiment); two real calibration errors were found and fixed through the validation process.

**Not yet built:** full calibration and validation of the breast model, a doctor's view (simulated scan and blood test), patient-time calibration and a published benchmark of the AI agent.

## 4. Target customers

**Iressa is built mainly for researchers.** Research labs and universities are our primary, paying customers; industry and teaching are secondary segments.

| Customer | Priority | Their pain | What Iressa gives them |
|---|---|---|---|
| Academic cancer research labs | **Primary** | Slow, expensive experiments; resistance is hard to observe and explain in papers | Test hypotheses about resistance and treatment schedules in minutes; full visibility into every cell; publication-ready 3D figures |
| Universities and research institutes | **Primary** | Each group builds its own models or has none; computational oncology needs programmers | A shared, validated platform for all their research groups, with support and updates |
| Computational and mathematical oncology groups | **Primary** | General simulators need a lot of setup before any cancer biology works | Cancer biology, calibrated data and an RL agent ready to use and extend |
| Biotech developing a targeted drug | Secondary | Unclear which dose, schedule or combination delays resistance | A model of their drug's resistance, calibrated to their data |
| Pharma modelling teams | Secondary | Population models don't show where resistance starts | A spatial, cell-level view that complements their existing models |
| Teachers and students | Secondary | Resistance is abstract and hard to picture | A tumour they can watch, pause and change |
| Liquid-biopsy (blood-test) companies | Secondary | Need to show why repeated blood tests matter | A visual story of mutations rising before scans change |

**Order of focus:** research labs and universities first, for both credibility and revenue; then biotech and pharma pilots once validation is published. Teaching is a steady side segment.

## 5. Market analysis

| Level | Market | Size | Evidence and caveat |
|---|---|---|---|
| Total | Broad biosimulation software and services | USD 4.47–4.9 bn (2025); about 17% growth a year to USD 11.3 bn by 2031 | [Mordor Intelligence](https://www.mordorintelligence.com/industry-reports/global-biosimulation-market-industry) and [Global Market Insights](https://www.gminsights.com/industry-analysis/biosimulation-market) estimates; not Iressa's addressable market |
| Adjacent | In-silico clinical trials | USD 3.97 bn (2025) to USD 8.51 bn (2035) | [SNS Insider](https://www.snsinsider.com/reports/in-silico-clinical-trials-market-6369); overlaps with biosimulation, so do not add to the total |
| Serviceable proxy | Global oncology biosimulation | ≈ USD 1.8 bn | Our calculation: USD 4.9 bn × the 36.8% oncology share reported by [Global Market Insights](https://www.gminsights.com/industry-analysis/biosimulation-market); broader than this product |
| Serviceable proxy, Europe | European oncology biosimulation | ≈ USD 0.4 bn | Our calculation: USD 1.1 bn Europe × 36.8%; assumes Europe's mix matches the global mix |
| Obtainable, year 3 | European research labs, universities, biotechs and schools | ≈ €0.47 m a year | Bottom-up revenue scenario in section 11; not a measured market share |

**Who buys:** [Mordor Intelligence](https://www.mordorintelligence.com/industry-reports/global-biosimulation-market-industry) estimates that pharma and biotech account for 62.5% of biosimulation spending, with academic and government research making up much of the rest, and that software is 67.1% of the market, with services the fastest-growing part. These are publisher estimates across a much broader category than this product.

**Patients behind the market:** [GLOBOCAN 2022 as summarised by WCRF](https://www.wcrf.org/preventing-cancer/cancer-statistics/worldwide-cancer-data/) records about 2.48 million new lung cancers and 2.30 million new female breast cancers worldwide. As a rough estimate of our own, 500,000–700,000 of the lung cancers each year are EGFR-mutant, about half of them in women, and ESR1 mutations are reported in roughly 20–40% of hormone-receptor-positive breast cancers after aromatase-inhibitor treatment. [EGFR prevalence varies substantially by region and study population](https://pmc.ncbi.nlm.nih.gov/articles/PMC5346692/), and ESR1 frequency depends on prior therapy and sampling, so these are indicative ranges. They describe disease burden, not customer counts or a market size.

## 6. Competitors

| Competitor | What they do | Our difference |
|---|---|---|
| Nova In Silico (ISELA model on the jinkō platform) | Equation-based EGFR lung model that predicts trial results, with [vendor-reported validation](https://www.novainsilico.ai/wp-content/uploads/2022/05/2022-04-12_AACRPoster_QRcode.pdf); sold as consulting and an enterprise platform | We show the tumour in 3D, cell by cell, and researchers run experiments themselves; priced for academic labs |
| PhysiCell, HAL, CompuCell3D | Free, general academic simulators; [PhysiCell also offers a browser-based no-code interface](https://physicell.org/) | Calibrated cancer biology, validation and an RL agent built in; cause-level 3D replay; support included |
| Certara, Simulations Plus | Broad pharmacology platforms | Focused on resistance evolution; affordable for universities |
| Turbine | AI-simulated single cells for target discovery | Whole tumour, space and treatment schedules |
| Lab experiments | The current default | Helps choose which experiments are worth running |

## 7. Competitive advantage

> **Honest position:** at least one competitor has a validated model of the same lung cancer, and free academic simulators exist. Our edge is the approach (spatial, explains every cell) and access (ready to use, supported, affordable for research groups), not the choice of cancer.

- **Validation:** a public, reproducible validation report already exists; next come patient-time calibration and clinical benchmarks (FLAURA for lung, SERENA-6 for breast).
- **Curated data and rules:** cleaned, provenance-tracked calibration data for each cancer, which is slow for others to rebuild.
- **Research partnerships:** joint validation studies with university labs make Iressa cited, trusted and embedded in research groups.
- **Product experience:** 3D, cause-level explanation and self-serve experiments, which population-level tools do not offer.
- **Platform:** each cancer is one model file on a shared engine, so adding a cancer (or a customer's drug) is mostly data work. Two cancers already run.
- **Explainable AI agent:** learns a treatment pattern in under a minute and explains each decision, which makes the science understandable to non-modellers.

## 8. Business model

Our main model is to **partner with researchers and universities, who pay us for licences.**

| Offer | For whom | Price (early assumption) |
|---|---|---|
| Free trial account | Any researcher; sign in with email or ORCID and try the hosted simulator with limits | Free |
| Lab licence | A single research group: full hosted platform, all validated models, AI agent, support, help calibrating to their data | ≈ €4k / year |
| Institutional licence | A university or research institute: access for all research groups, priority support, updates, training sessions | ≈ €15–25k / year |
| Classroom licence | Universities, schools: guided scenarios, teaching material | ≈ €1.5k / year |
| Research partnership | University labs running joint validation studies | Reduced or free licence in exchange for data, validation and co-authorship |
| Industry pilot (later) | Biotech: we model their drug's resistance | €20–35k per pilot |

**What the licence pays for:** the hosted platform, validated and calibrated cancer models, the AI agent, updates, support and calibration help. Because the code is public under the MIT licence, we do not charge for the code itself. If we want to sell licences for the software too, we should move from MIT to a dual licence (for example AGPL for free use plus a paid commercial licence) before outside contributions arrive.

## 9. Marketing & sales

| Step | Who | How |
|---|---|---|
| 1. Partnerships (months 0–6) | European mathematical-oncology and cancer-biology groups | Research partnerships, joint validation study, preprint |
| 2. First licences (months 6–12) | Research labs and universities | Lab licences through partner introductions; first institutional licence |
| 3. Scale (year 2+) | More universities and institutes; biotech and pharma | Institutional licences after published validation; first industry pilots |
| Ongoing | Universities and schools | Classroom licences, guest lectures |

**Funnel:** landing page → free trial account (email or ORCID) → experiments in the hosted simulator → lab licence → institutional licence. Accounts let us measure sign-ups, active researchers and which labs to approach.

**Channels:** the website and GitHub, a validation preprint, university tech-transfer and research offices, and European and international conferences (ESMO, EACR, IASLC World Conference on Lung Cancer, San Antonio Breast Cancer Symposium). The team is based in Bulgaria and sells across Europe.

**Validating demand (next two weeks):** no customer interviews have been run yet. Plan: 10 short conversations, starting with mentors and judges at the hackathon, then European researchers and university research offices.

| Question | Result |
|---|---|
| Would you use a 3D simulator to test treatment schedules before lab work? | [X of Y] |
| What would you use it for first: research, teaching, or a specific drug? | [answer] |
| What would you need before trusting its results? | [top 3] |
| Would your lab or university pay for a licence? Roughly how much, and from which budget? | [range] |
| Would you join a validation study or sign a letter of intent? | [names / LOIs] |

## 10. Operations & technology

| Area | How it works |
|---|---|
| Technology | Python simulation engine (calibration, physics, treatment schedules, AI agent and reinforcement-learning layer) and a TypeScript 3D viewer that runs in the browser. Both share one recorded-run format. |
| Data-driven design | Every biological rule, rate and schedule lives in editable data files, validated against schemas. Each cancer is one model file (lung and breast today), so a new cancer or a customer's drug is mostly new data, not new code. |
| Accounts and licences | Supabase handles sign-in (email, password reset, ORCID) and researcher profiles with owner-only access rules; no passwords or tokens are logged. Licence tiers will be added on the same accounts. |
| Quality | Automated tests for the engine, calibration, export and viewer; a reproducible validation suite and a frozen engine version for each release. |
| Hosting | The landing page (`/`) and the viewer (`/simulation`) run in the visitor's browser, so hosting is cheap; only the AI agent needs a small server. Today the site runs on our own server behind a Cloudflare Tunnel. Heavy runs happen on our servers or the institution's own. |
| Onboarding a licensed lab | 1) Set up accounts for the group; 2) training session; 3) optional calibration to the lab's own cell-line data; 4) ongoing support and model updates. |
| Delivering an industry pilot | 1) Collect the customer's drug and cell-line data; 2) calibrate a private copy of the rules; 3) run virtual cohorts; 4) deliver a report and a 3D replay; 5) optional private deployment. |
| Tools and workflow | GitHub (code, issues, reviews), public validation report. |

**Regulation:** Iressa is intended for research and teaching, not clinical decisions. Whether future patient-facing software qualifies as an EU medical device depends on its intended purpose and functionality under [EU medical-device software guidance](https://health.ec.europa.eu/document/download/b45335c5-1679-4c71-a91c-fc7a4d37f12b_en?filename=md_mdcg_2019_11_guidance_qualification_classification_software_en.pdf); a research-use label alone is not a legal determination. Product, website and contracts state: *"Research use only. Not for clinical decision-making."* Dose controls limit modelled exposure and never give dosing advice.

**Legal and intellectual property**

- **Licence:** MIT today. Simple and good for adoption, but anyone, including competitors, may reuse the code. Since licences are our main revenue, decide before outside contributions whether to keep MIT (and sell the hosted platform and services) or move to a dual licence such as AGPL plus a commercial licence.
- **Name:** [Iressa is the marketed name of gefitinib](https://www.ema.europa.eu/en/medicines/human/EPAR/iressa), with AstraZeneca as marketing-authorisation holder. Keep it as a hackathon codename only; obtain trademark advice and rename before any commercial use, all the more since the platform is expanding beyond lung cancer.
- **Data:** check commercial-use terms of GDSC, Cell Model Passports, CIViC and cBioPortal; licensed labs can bring their own data.
- **Personal data (GDPR):** research accounts store names, emails and ORCID iDs, which are personal data under [European Commission guidance](https://commission.europa.eu/law/law-topic/data-protection/information-business-and-organisations/application-gdpr_en). We need a privacy policy, terms of use, an EU data region for Supabase and a data-processing agreement with each licensed institution, reviewed with counsel. Lab data stays private to the lab.
- **Company:** register a company in the EU (for example a Bulgarian EOOD) at the first paid licence.

## 11. Financial plan

| | Year 1 | Year 2 | Year 3 |
|---|---|---|---|
| Lab licences | 5 × €4k | 15 × €4k | 30 × €4k |
| Institutional licences | 1 × €15k | 4 × €20k | 10 × €20k |
| Classroom licences | 0 | 10 × €1.5k | 30 × €1.5k |
| Industry pilots | 1 × €20k | 2 × €30k | 3 × €35k |
| **Revenue** | **€55k** | **€215k** | **€470k** |
| People | €90k (2) | €200k (4) | €300k (5–6) |
| Validation studies | €30k | €30k | €40k |
| Hosting and accounts, legal, data licences, travel | €20k | €30k | €40k |
| **Costs** | **€140k** | **€260k** | **€380k** |
| **Result** | **−€85k** (to be funded) | **−€45k** (grant or seed) | **+€90k** |

*Our assumptions, to be tested in customer interviews. Research and classroom licences are about 64% of revenue in year 1, rising to about 78% in year 3; industry pilots are upside. Hosting stays cheap because the viewer runs in the user's browser. Breast cancer roughly doubles the pool of interested research groups from year 2.*

**Funding needs:** the year 1 gap of about €85k and year 2 gap of about €45k are planned to be covered by hackathon prizes, university and accelerator programmes, EU funding (Horizon Europe health calls, EIC Pathfinder, later EIC Accelerator), national innovation funds and early licences. *Check current calls and eligibility.*

**Unit economics (assumption):** a licence has almost no extra cost per customer because the software is already built; the main cost is support and onboarding (a few days per lab per year). An industry pilot costs mainly 1–2 person-months of calibration work, so a €20–35k pilot has a healthy margin.

## 12. Roadmap

| When | Milestone |
|---|---|
| Done (hackathon) | 3D viewer, calibrated lung engine and validation report, breast cancer model (research version), AI agent with plain-language explanations, experiment controls with dose limits, research accounts (email, ORCID), landing page, live deployment |
| 0–3 months | Calibrate and validate the breast model; doctor's view (simulated scan and blood test); privacy policy and terms; decide licence and new name; 1–2 university research partners |
| 3–9 months | Patient-time calibration; clinical benchmarks (FLAURA, SERENA-6); validation preprint; AI agent benchmarked against standard strategies; licence tiers in the platform |
| 6–12 months | First lab and institutional licences; grant applications; company registration; first industry pilot |
| 12–24 months | More university partners; customer-data calibration, large cohorts, private deployment |
| Later | More single-gene cancers (ALK, ROS1, KRAS G12C, HER2+ breast), drug combinations, immune cells |

## 13. Research used and evidence limits

- **Clinical context:** [FLAURA](https://www.nejm.org/doi/full/10.1056/NEJMoa1713137) provides trial-level progression-free survival for first-line EGFR inhibitors; [SERENA-6](https://www.nejm.org/doi/full/10.1056/NEJMoa2502929) supports the relevance of detecting emerging ESR1 mutations; [Fribbens et al.](https://pmc.ncbi.nlm.nih.gov/articles/PMC4998737/) reports ESR1 prevalence in defined, small treatment cohorts. None calibrates Iressa's patient-level outcomes.
- **Disease burden and genotype prevalence:** [GLOBOCAN 2022/WCRF](https://www.wcrf.org/preventing-cancer/cancer-statistics/worldwide-cancer-data/) supplies global incidence and deaths; this [EGFR prevalence meta-analysis](https://pmc.ncbi.nlm.nih.gov/articles/PMC5346692/) shows geographic variation. The EGFR-mutant patient range in section 5 is our own rough estimate. Incidence and mutation prevalence are not software buyer counts.
- **Market estimates:** [Mordor Intelligence](https://www.mordorintelligence.com/industry-reports/global-biosimulation-market-industry), [Global Market Insights](https://www.gminsights.com/industry-analysis/biosimulation-market) and [SNS Insider](https://www.snsinsider.com/reports/in-silico-clinical-trials-market-6369) publish proprietary category forecasts. Definitions overlap; the European oncology figure is our extrapolation, not a directly reported segment.
- **Product and competition:** [Local model references](docs/references.md), [breast-model evidence](docs/breast_er_positive.md), [validation report](docs/validation/VALIDATION_REPORT.md), [Nova In Silico's ISELA poster](https://www.novainsilico.ai/wp-content/uploads/2022/05/2022-04-12_AACRPoster_QRcode.pdf) and [PhysiCell's product description](https://physicell.org/) support technical and competitor statements. Vendor claims and internal validation are not independent clinical replication.
- **Regulatory and naming checks:** [EU medical-device software guidance](https://health.ec.europa.eu/document/download/b45335c5-1679-4c71-a91c-fc7a4d37f12b_en?filename=md_mdcg_2019_11_guidance_qualification_classification_software_en.pdf), [GDPR guidance](https://commission.europa.eu/law/law-topic/data-protection/information-business-and-organisations/application-gdpr_en) and the [EMA Iressa listing](https://www.ema.europa.eu/en/medicines/human/EPAR/iressa). Legal and trademark status need professional review before launch.
- **Unvalidated business assumptions:** licence prices, the number of labs and universities that will pay, conversion from free trial to licence, support and pilot effort, margins, the year-3 revenue scenario and claimed time savings are hypotheses. No customer interviews, letters of intent or paid licences are reported yet.

---

*Prices, revenue figures and the European market estimate are our assumptions. Market sizes come from the named reports; patient and death numbers from WCRF / GLOBOCAN 2022. Iressa is a research and teaching tool, not medical advice.*
