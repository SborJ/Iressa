# Calibration Report

## Data Sources

- GDSC / Cell Model Passports: genotype and drug response when raw exports are present.
- CIViC: literature evidence for sensitivity/resistance relationships.
- cBioPortal: patient/sample alteration prevalence and co-occurrence context.

## Input Files

| source | present | rows | sha256 |
| --- | --- | ---: | --- |
| gdsc_drug_response | True | 2870 | `b472905ea811c145b1827f382975756a66c2ac5dffbe9ad323148bfdea38cdb5` |
| cell_model_passports_mutations | True | 17 | `52f38dd03a5a246dd81f26a7f54a32e9be2f05e45b8d7eb7eebd7a5bcc8c989e` |
| civic_evidence | True | 69 | `c8393e5708835572922d248c2561bbed13601db94a63426c5f9a1e72ea68ae0f` |
| cbioportal_alterations | True | 777 | `901439d00f53aaac7cba1f17b89ed2231f6c053af64bab1cd501a5a0716dfd5b` |

## Final Clones

### EGFR-mutant

- Alterations: EGFR_exon19del_or_L858R
- Growth rate: 0.22753526000680058 1/day (measured)
- Fitness cost: 0.0 (not_applied; measured clone-specific growth_rate_per_day is used directly)
- gefitinib IC50: 446.36165169016465 nM (measured, n=4)
- osimertinib IC50: 58.456360258609266 nM (measured, n=4)
- capmatinib IC50: 8000.0 nM (assumed, n=0)
- Sensitivity evidence: CIViC 11241: EGFR L858R OR EGFR Exon 19 Deletion SENSITIVITYRESPONSE gefitinib; CIViC 275: EGFR L858R SENSITIVITYRESPONSE gefitinib|erlotinib; CIViC 2621: EGFR L858R SENSITIVITYRESPONSE gefitinib; CIViC 4759: EGFR L858R OR EGFR Exon 19 Deletion SENSITIVITYRESPONSE erlotinib|gefitinib; CIViC 229: EGFR L858R SENSITIVITYRESPONSE gefitinib|erlotinib
- Matched models: SIDM00046, SIDM00237, SIDM00745, SIDM01067

### EGFR + T790M

- Alterations: EGFR_exon19del_or_L858R, EGFR_T790M
- Growth rate: 0.4073342882820442 1/day (measured)
- Fitness cost: 0.0 (not_applied; measured clone-specific growth_rate_per_day is used directly)
- gefitinib IC50: 13643.715326962285 nM (measured, n=1)
- osimertinib IC50: 37.92578709404305 nM (measured, n=1)
- capmatinib IC50: 8000.0 nM (assumed, n=0)
- Sensitivity evidence: CIViC 1592: EGFR T790M SENSITIVITYRESPONSE osimertinib; CIViC 1867: EGFR T790M SENSITIVITYRESPONSE osimertinib; CIViC 11598: EGFR T790M AND EGFR Exon 19 Deletion SENSITIVITYRESPONSE osimertinib; CIViC 11599: EGFR L858R AND EGFR T790M SENSITIVITYRESPONSE osimertinib; CIViC 965: EGFR T790M SENSITIVITYRESPONSE osimertinib
- Resistance evidence: CIViC 239: EGFR T790M RESISTANCE gefitinib; CIViC 1391: EGFR T790M RESISTANCE gefitinib|erlotinib; CIViC 1667: EGFR T790M RESISTANCE gefitinib|erlotinib; CIViC 2159: EGFR T790M RESISTANCE gefitinib; CIViC 2158: EGFR T790M RESISTANCE gefitinib|erlotinib
- Transition evidence: CIViC 239: EGFR T790M RESISTANCE gefitinib; CIViC 1391: EGFR T790M RESISTANCE gefitinib|erlotinib; CIViC 1667: EGFR T790M RESISTANCE gefitinib|erlotinib; CIViC 2159: EGFR T790M RESISTANCE gefitinib; CIViC 2158: EGFR T790M RESISTANCE gefitinib|erlotinib
- Matched models: SIDM00759

### EGFR + T790M + C797S

- Alterations: EGFR_exon19del_or_L858R, EGFR_T790M, EGFR_C797S
- Growth rate: 0.029 1/day (assumed)
- Fitness cost: 0.18 (assumed; curated simulator seed)
- gefitinib IC50: 17000.0 nM (assumed, n=0)
- osimertinib IC50: 9200.0 nM (assumed, n=0)
- capmatinib IC50: 8000.0 nM (assumed, n=0)
- Resistance evidence: CIViC 1396: EGFR T790M AND EGFR Exon 19 Deletion AND EGFR C797S RESISTANCE osimertinib; CIViC 964: EGFR C797S RESISTANCE osimertinib
- Transition evidence: CIViC 1396: EGFR T790M AND EGFR Exon 19 Deletion AND EGFR C797S RESISTANCE osimertinib; CIViC 964: EGFR C797S RESISTANCE osimertinib
- Matched models: none; using fallback/assumed clone parameters where needed.

### EGFR + MET amplification

- Alterations: EGFR_exon19del_or_L858R, MET_amplification
- Growth rate: 0.034 1/day (assumed)
- Fitness cost: 0.06 (assumed; curated simulator seed)
- gefitinib IC50: 4500.0 nM (assumed, n=0)
- osimertinib IC50: 2200.0 nM (assumed, n=0)
- capmatinib IC50: 80.0 nM (assumed, n=0)
- Resistance evidence: CIViC 1392: MET Amplification RESISTANCE gefitinib|erlotinib; CIViC 733: MET Amplification RESISTANCE gefitinib
- Transition evidence: CIViC 1392: MET Amplification RESISTANCE gefitinib|erlotinib; CIViC 733: MET Amplification RESISTANCE gefitinib
- Matched models: SIDM01598

## Resistance Graph

- EGFR -> T790M via EGFR_T790M: resistance in gefitinib/erlotinib; simulation probability 2e-05 (assumed)
- T790M -> C797S via EGFR_C797S: resistance in osimertinib; simulation probability 1e-05 (assumed)
- EGFR -> MET_AMP via MET_amplification: resistance in EGFR inhibitor; simulation probability 1e-05 (assumed)
- T790M -> MET_AMP via MET_amplification: resistance in EGFR inhibitor; simulation probability 1e-05 (assumed)

## Physical Calibration

- lattice spacing: 20 um
- physical calibration field step: 5 minutes
- biological experiment time: configured separately in days with --days and --dt-days
- runtime oxygen solver: quasi-steady iterative solve
- runtime drug solver: explicit diffusion with automatic stability/time substeps
- drug max-death rates are interpreted as day^-1
- hypoxic death rates are interpreted as day^-1; necrosis exposure time is interpreted in days
- oxygen diffusion grid coefficient: 1500
- gefitinib: mode=normalized, vessel concentration=1000 nM, grid diffusion=375
- osimertinib: mode=normalized, vessel concentration=1000 nM, grid diffusion=375
- capmatinib: mode=normalized, vessel concentration=1000 nM, grid diffusion=375

## Assumptions And Warnings

- Measured data, literature-derived evidence, inferred values, and simulation assumptions are intentionally kept separate.
- Mutation probabilities per division are not inferred from cBioPortal prevalence.
- Vessel drug concentrations are simulation assumptions unless explicitly calibrated to pharmacokinetic data.
- WARNING: oxygen physical diffusion grid coefficient 1500 exceeds the single-step explicit 2D stability limit; avoid one biological CA step as one explicit diffusion step. Runtime field updates use quasi-steady oxygen and drug diffusion substeps.
- WARNING: gefitinib physical diffusion grid coefficient 375 exceeds the single-step explicit 2D stability limit; avoid one biological CA step as one explicit diffusion step. Runtime field updates use quasi-steady oxygen and drug diffusion substeps.
- WARNING: osimertinib physical diffusion grid coefficient 375 exceeds the single-step explicit 2D stability limit; avoid one biological CA step as one explicit diffusion step. Runtime field updates use quasi-steady oxygen and drug diffusion substeps.
- WARNING: capmatinib physical diffusion grid coefficient 375 exceeds the single-step explicit 2D stability limit; avoid one biological CA step as one explicit diffusion step. Runtime field updates use quasi-steady oxygen and drug diffusion substeps.
