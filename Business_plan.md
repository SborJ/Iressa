# Business Plan
Iressa · October 2026

## 1. Executive summary
Targeted cancer drugs usually stop working because the tumour evolves resistance. Iressa is an open-source 3D simulator, calibrated on public lab data, that shows how a tumour becomes resistant and lets researchers compare treatment schedules before spending months in the lab.

It now covers two cancers: EGFR-mutant lung cancer (calibrated and validated) and ER-positive breast cancer (research version). An AI agent learns a treatment pattern in under a minute and ranks it against standard strategies. Researchers sign in with email or ORCID.

We sell to biotech and pharma through paid pilots, calibration to their own data and private deployment, while labs and schools use the free core.

## 2. Problem
In the [FLAURA trial](https://www.nejm.org/doi/full/10.1056/NEJMoa1713137), median progression-free survival was 10.2 months with gefitinib or erlotinib and 18.9 months with osimertinib in previously untreated EGFR-mutant advanced lung cancer. These are trial medians, not predicted failure times for an individual patient.
Resistance can emerge as tumour clones evolve under treatment. In one [observational study of advanced breast cancer](https://pmc.ncbi.nlm.nih.gov/articles/PMC4998737/), ESR1 mutations were found in 16 of 44 patients first exposed to aromatase inhibitors in the metastatic setting; this small, selected cohort does not establish a population-wide 40% rate. [SERENA-6](https://www.nejm.org/doi/full/10.1056/NEJMoa2502929) tested switching treatment after an emerging ESR1 mutation was detected.
Standard monitoring cannot directly show the cell families competing inside a tumour. Laboratory experiments and bespoke simulation work can be slow or costly; the time and cost savings Iressa could offer still need prospective user validation.

## 3. Solution / Product
Public repository github.com/SborJ/Iressa (MIT licence). Built and working at the hackathon:

Part	What it gives the customer
3D tumour viewer	A tumour grown cell by cell with blood vessels, oxygen and drug. Cut it open, switch between tissue, fluorescence and histology views, and hover any cell to see why it is alive, resting or dying.
Calibrated engine	Cancer cell types and drug responses calibrated on public data (GDSC2, Cell Model Passports, CIViC, cBioPortal). Every rule lives in an editable data file.
Validation report	Data audited with checksums, solvers checked, 20 runs per schedule, sensitivity analysis. Verdict: pass with listed limitations.
Experiment controls	Compare treatment schedules (continuous, switching, adaptive) in the interface. Modelled exposure is constrained by literature-based ceilings, with a warning when a request is held back; these are not patient-specific safety or prescribing limits.
Breast cancer model (research version)	ER-positive, HER2-negative breast cancer on the same engine: aromatase inhibitor, CDK4/6 inhibitor (palbociclib) and receptor-destroying drugs (fulvestrant, elacestrant); ESR1-mutant and CDK4/6-escape clones; early- vs late-switch strategies.
AI agent	One button adds an agent that learns a treatment pattern in 15–60 seconds, plays it on an unseen tumour, explains each decision in plain language and ranks it against the standard strategies. A deeper research layer (PPO) is also included.
Research accounts	Sign-in with email or ORCID (the researcher ID used in science), password reset and researcher profiles. The landing page is public; the simulator opens after sign-in.
Website	Landing page at the root of the site, simulator at /simulation.
Proof points so far: the lung engine reproduces the known clinical order of resistance (EGFR → T790M → C797S/MET); in the breast model, switching drugs early leaves a much smaller tumour than switching late (first 5-tumour experiment); two real calibration errors were found and fixed through the validation process.

Not yet built: full calibration and validation of the breast model, a doctor's view (simulated scan and blood test), patient-time calibration and a published benchmark of the AI agent.

## 4. Target customers
Customer	Their pain	What Iressa gives them
Academic labs	Slow, expensive experiments; hard to explain resistance in papers	Test ideas in minutes; publication-ready 3D figures; free
Biotech developing a targeted drug	Unclear which dose, schedule or combination delays resistance	A model of their drug's resistance, calibrated to their data
Pharma modelling teams	Population models don't show where resistance starts	A spatial, cell-level view that complements their existing models
Teachers and students	Resistance is abstract and hard to picture	A tumour they can watch, pause and change
Liquid-biopsy (blood-test) companies	Need to show why repeated blood tests matter	A visual story of mutations rising before scans change
Order of focus: academic labs first for credibility, then biotech for the first revenue, then pharma for scale. Teachers and students are a steady side segment.

## 5. Market analysis
| Level | Market | Size | Evidence and caveat |
|---|---|---|---|
| Total | Broad biosimulation software and services | USD 4.47–4.9 bn (2025); Mordor forecasts USD 11.3 bn by 2031 | [Mordor](https://www.mordorintelligence.com/industry-reports/global-biosimulation-market-industry) and [Global Market Insights](https://www.gminsights.com/industry-analysis/biosimulation-market) estimates; not Iressa's addressable market |
| Adjacent | In-silico clinical trials | USD 3.97 bn (2025) to USD 8.51 bn (2035) | [SNS Insider](https://www.snsinsider.com/reports/in-silico-clinical-trials-market-6369); overlaps with biosimulation, so do not add to total |
| Serviceable proxy | Global oncology biosimulation | ≈ USD 1.8 bn | Our calculation: USD 4.9 bn × 36.8% global oncology share reported by [Global Market Insights](https://www.gminsights.com/industry-analysis/biosimulation-market); broader than this product |
| Serviceable proxy, Europe | European oncology biosimulation | ≈ USD 0.4 bn | Our calculation: USD 1.1 bn Europe × 36.8% global oncology share from [Global Market Insights](https://www.gminsights.com/industry-analysis/biosimulation-market); assumes Europe's mix matches the global mix |
| Obtainable, year 3 | European labs, biotechs and schools | €0.4 m a year | Revenue scenario in section 11; not a measured market share |

Mordor's USD 11.3 bn forecast implies a 16.72% compound annual growth rate from 2026 to 2031, under its proprietary methodology.

[GLOBOCAN 2022 as summarised by WCRF](https://www.wcrf.org/preventing-cancer/cancer-statistics/worldwide-cancer-data/) records about 2.48 million new lung cancers and 2.30 million new female breast cancers worldwide. These are disease-burden figures, not customer counts or a market-size calculation. [EGFR mutation prevalence varies substantially by region and study population](https://pmc.ncbi.nlm.nih.gov/articles/PMC5346692/), so we do not treat a single global patient estimate as a validated market input. ESR1 mutation frequency also depends on prior therapy and sampling; the selected cohort in section 2 is not a general rate for all breast cancers.

[Mordor Intelligence](https://www.mordorintelligence.com/industry-reports/global-biosimulation-market-industry) estimates that pharma and biotech account for 62.5% of biosimulation spending and software for 67.1% of the market. These are publisher estimates across a much broader category than this product.

## 6. Competitors
Competitor	What they do	Our difference
Nova In Silico (ISELA model on the jinkō platform)	Equation-based EGFR lung model; [vendor-reported validation](https://www.novainsilico.ai/wp-content/uploads/2022/05/2022-04-12_AACRPoster_QRcode.pdf) and enterprise offering	We show the tumour in 3D, cell by cell, and researchers run experiments themselves; open source
PhysiCell, HAL, CompuCell3D	Free, general academic simulators; [PhysiCell also offers a browser-based no-code interface](https://physicell.org/)	Focused EGFR/MET workflow, provenance-labelled calibration and cause-level 3D replay
Certara, Simulations Plus	Broad pharmacology platforms	Focused on resistance evolution; affordable
Turbine	AI-simulated single cells for target discovery	Whole tumour, space and treatment schedules
Lab experiments	The current default	Helps choose which experiments are worth running
## 7. Competitive advantage
Honest position: at least one competitor has a validated model of the same lung cancer. Our edge is the approach (spatial, explains every cell, open) and access (self-serve, affordable), not the choice of cancer.

Validation: a public, reproducible validation report already exists; next come patient-time calibration and clinical benchmarks (FLAURA for lung, SERENA-6 for breast).
Curated data and rules: cleaned, provenance-tracked calibration data for each cancer, which is slow for others to rebuild.
Open community: MIT licence and editable rules make it easy for labs to adopt, cite and contribute.
Product experience: 3D, cause-level explanation and self-serve experiments, which population-level tools do not offer.
Platform: each cancer is one model file on a shared engine, so adding a cancer (or a customer's drug) is mostly data work. Two cancers already run.
Explainable AI agent: learns a treatment pattern in under a minute and explains each decision, which makes the science understandable to non-modellers.
## 8. Business model
Offer	For whom	Price (early assumption)
Open-source core (MIT)	Everyone; builds users, citations and trust	Free
Free research account	Researchers sign in (email or ORCID) to use the hosted simulator; gives us a measurable user base	Free
Classroom licence	Universities, schools: guided scenarios, teaching material	≈ €1.5k / year
Custom modelling pilot	Biotech: we model their drug's resistance	€20–35k per pilot
Pro / enterprise	Calibration to the customer's data, large virtual cohorts, private deployment, support, validation reports	Tens of thousands € / year
Partnerships	Liquid-biopsy companies, CROs	Revenue share or co-marketing
Because the code is MIT-licensed, revenue comes from expertise, calibration, hosting and support, not from selling the code. This is the usual open-core model for scientific software.

## 9. Marketing & sales
Step	Who	How
1. Credibility (months 0–6)	European mathematical-oncology and cancer-biology groups	Free core, joint validation study, preprint
2. First revenue (months 6–12)	European biotechs developing EGFR, MET or hormone-receptor drugs	Paid pilots through academic introductions
3. Scale (year 2+)	Pharma modelling teams, CROs	Pro licences after published validation
Ongoing	Universities and schools	Classroom licences, guest lectures
Funnel: landing page → free research account (email or ORCID) → experiments in the hosted simulator → pilot or Pro conversation. Accounts let us measure sign-ups and active researchers.

Channels: the website and GitHub, a validation preprint, and European and international conferences (ESMO, EACR, IASLC World Conference on Lung Cancer, San Antonio Breast Cancer Symposium). The team is based in Bulgaria and sells across Europe.

Validating demand (next two weeks): no customer interviews have been run yet. Plan: 10 short conversations, starting with mentors and judges at the hackathon, then European researchers and biotechs.

Question	Result
Would you use a 3D simulator to test treatment schedules before lab work?	[X of Y]
What would you use it for first: research, teaching, or your own drug?	[answer]
What would you need before trusting its results?	[top 3]
Would you pay for calibration to your own data? Roughly how much?	[range]
Would you join a validation study or sign a letter of intent?	[names / LOIs]
## 10. Operations & technology
Area	How it works
Technology	Python simulation engine (calibration, physics, treatment schedules, AI agent and reinforcement-learning layer) and a TypeScript 3D viewer that runs in the browser. Both share one recorded-run format.
Data-driven design	Every biological rule, rate and schedule lives in editable data files, validated against schemas. Each cancer is one model file (lung and breast today), so a new cancer or a customer's drug is mostly new data, not new code.
Accounts	Supabase handles sign-in (email, password reset, ORCID) and researcher profiles with owner-only access rules; no passwords or tokens are logged.
Quality	Automated tests for the engine, calibration, export and viewer; a reproducible validation suite and a frozen engine version for each release.
Hosting	Website and viewer are static files (landing page at /, simulator at /simulation), so hosting is cheap. Heavy runs happen on the customer's or our own servers for Pro work.
Delivering a pilot	1) Collect the customer's drug and cell-line data; 2) calibrate a private copy of the rules; 3) run virtual cohorts; 4) deliver a report and a 3D replay; 5) optional private deployment.
Tools and workflow	GitHub (code, issues, reviews), open-source licence, public validation report.
Regulation: Iressa is intended for research and teaching, not clinical decisions. Whether future patient-facing software qualifies as an EU medical device depends on its intended purpose and functionality under [EU medical-device software guidance](https://health.ec.europa.eu/document/download/b45335c5-1679-4c71-a91c-fc7a4d37f12b_en?filename=md_mdcg_2019_11_guidance_qualification_classification_software_en.pdf); a research-use label alone is not a legal determination. Product, website and contracts state: "Research use only. Not for clinical decision-making." Dose controls limit modelled exposure, not clinical dosing.

Legal and intellectual property

Licence: MIT today. Simple and good for adoption; anyone, including competitors, may reuse the code. Decide before outside contributions whether to keep MIT or move the core to a copyleft licence such as AGPL.
Name: [Iressa is the marketed name of gefitinib](https://www.ema.europa.eu/en/medicines/human/EPAR/iressa), with AstraZeneca as marketing-authorisation holder. Treat it as a hackathon codename; obtain trademark advice and choose a new name before commercial use.
Data: check commercial-use terms of GDSC, Cell Model Passports, CIViC and cBioPortal; Pro customers can bring their own data.
Personal data (GDPR): research accounts store names, emails and ORCID iDs, which are personal data under [European Commission guidance](https://commission.europa.eu/law/law-topic/data-protection/information-business-and-organisations/application-gdpr_en). Assess the required privacy notices, lawful basis, processor agreements and hosting location with counsel. Customer lab data stays in the customer's deployment.
Company: register a company in the EU (for example a Bulgarian EOOD) at the first paid pilot.
## 11. Financial plan
Year 1	Year 2	Year 3
Paid pilots	2 × €20k	4 × €30k	5 × €35k
Pro / enterprise licences	0	2 × €25k	6 × €30k
Classroom licences	0	10 × €1.5k	30 × €1.5k
Revenue	€40k	€185k	€400k
People	€90k (2)	€200k (4)	€300k (5–6)
Validation studies	€30k	€30k	€40k
Hosting and accounts, legal, data licences, travel	€20k	€30k	€40k
Costs	€140k	€260k	€380k
Result	−€100k (to be funded)	−€75k (grant or seed)	+€20k (near break-even)
Our assumptions, to be tested in customer interviews. Hosting stays cheap because the viewer runs in the user's browser. Breast cancer is treated as upside: it roughly doubles the pool of possible pilot customers from year 2.

Funding needs: the year 1 gap of about €100k and year 2 gap of about €75k are planned to be covered by hackathon prizes, university and accelerator programmes, EU funding (Horizon Europe health calls, EIC Pathfinder, later EIC Accelerator), national innovation funds and paid pilots. Check current calls and eligibility.

Unit economics (assumption): a pilot costs us mainly 1–2 person-months of calibration work, so a €20–35k pilot has a healthy margin; licences have almost no extra cost per customer because the software is already built.

## 12. Roadmap
When	Milestone
Done (hackathon)	3D viewer, calibrated lung engine and validation report, breast cancer model (research version), AI agent with plain-language explanations, experiment controls with dose limits, research accounts (email, ORCID), landing page
0–3 months	Calibrate and validate the breast model; doctor's view (simulated scan and blood test); privacy policy and terms; decide licence and new name; 1–2 academic partners
3–9 months	Patient-time calibration; clinical benchmarks (FLAURA, SERENA-6); validation preprint; AI agent benchmarked against standard strategies
6–12 months	First paid pilot; grant applications; company registration
12–24 months	Pro version: customer-data calibration, large cohorts, private deployment
Later	More single-gene cancers (ALK, ROS1, KRAS G12C, HER2+ breast), drug combinations, immune cells
## 13. Research used and evidence limits

- **Clinical context:** [FLAURA](https://www.nejm.org/doi/full/10.1056/NEJMoa1713137) provides trial-level progression-free survival for first-line EGFR inhibitors; [SERENA-6](https://www.nejm.org/doi/full/10.1056/NEJMoa2502929) supports the relevance of detecting emerging ESR1 mutations; [Fribbens et al.](https://pmc.ncbi.nlm.nih.gov/articles/PMC4998737/) reports ESR1 prevalence in defined, small treatment cohorts. None calibrates Iressa's patient-level outcomes.
- **Disease burden and genotype prevalence:** [GLOBOCAN 2022/WCRF](https://www.wcrf.org/preventing-cancer/cancer-statistics/worldwide-cancer-data/) supplies global incidence; this [EGFR prevalence meta-analysis](https://pmc.ncbi.nlm.nih.gov/articles/PMC5346692/) shows geographic variation. Incidence and mutation prevalence are not software buyer counts.
- **Market estimates:** [Mordor Intelligence](https://www.mordorintelligence.com/industry-reports/global-biosimulation-market-industry), [Global Market Insights](https://www.gminsights.com/industry-analysis/biosimulation-market) and [SNS Insider](https://www.snsinsider.com/reports/in-silico-clinical-trials-market-6369) publish proprietary category forecasts. Definitions overlap; the European oncology figure above is our extrapolation, not a directly reported segment.
- **Product and competition:** [Local model references](docs/references.md), [breast-model evidence](docs/breast_er_positive.md), [validation report](docs/validation/VALIDATION_REPORT.md), [Nova In Silico's ISELA poster](https://www.novainsilico.ai/wp-content/uploads/2022/05/2022-04-12_AACRPoster_QRcode.pdf) and [PhysiCell's product description](https://physicell.org/) support technical and competitor statements. Vendor claims and internal validation are not independent clinical replication.
- **Regulatory and naming checks:** [EU medical-device software guidance](https://health.ec.europa.eu/document/download/b45335c5-1679-4c71-a91c-fc7a4d37f12b_en?filename=md_mdcg_2019_11_guidance_qualification_classification_software_en.pdf), [GDPR guidance](https://commission.europa.eu/law/law-topic/data-protection/information-business-and-organisations/application-gdpr_en) and the [EMA Iressa listing](https://www.ema.europa.eu/en/medicines/human/EPAR/iressa). Legal and trademark status need professional review before launch.
- **Unvalidated business assumptions:** Prices, conversion rates, pilot effort and margins, the year-3 revenue scenario, customer demand and claimed time savings are hypotheses. No customer interviews or paid-pilot evidence are reported yet.

Iressa is a research and teaching tool, not medical advice.
