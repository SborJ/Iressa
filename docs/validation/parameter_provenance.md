# Parameter provenance

| scope | parameter | value | unit | status | n | range | source |
| --- | --- | ---: | --- | --- | ---: | --- | --- |
| EGFR | growth_rate | 0.2742 | 1/day | measured | 5 | 0.1733-0.3838 | Cell Model Passports growth_rate_latest.csv |
| EGFR | fitness_cost | 0 | fraction | not_applied | 0 | 0-0 | measured clone-specific growth_rate_per_day is used directly |
| EGFR | max_drug_death_rate | 0.4621 | 1/day | inferred | 0 | 0.4621-0.4621 | derived from IC50 definition: GDSC2 fitted dose-response: IC50 is the concentration giving 50% relative viability after 72 h of exposure (Yang W et al. NAR 2013 (GDSC); Iorio F et al. Cell 2016; Vis DJ et al. Pharmacogenomics 2016 (IC50 fitting); GDSC_Fitted_Data_Description.pdf release 8.5) |
| EGFR | hill_coefficient | 1.2 | dimensionless | assumed | 0 |  | curated simulator seed; GDSC sigmoid slopes are not exported per curve |
| EGFR | gefitinib_ic50 | 247.3 | nM | measured | 5 | 64.85-4124 | normalized drug_response.csv |
| EGFR | osimertinib_ic50 | 73.94 | nM | measured | 5 | 27.58-1341 | normalized drug_response.csv |
| EGFR | capmatinib_ic50 | 8000 | nM | assumed | 0 | 8000-8000 | curated simulator seed fallback |
| T790M | growth_rate | 0.4073 | 1/day | measured | 1 | 0.4073-0.4073 | Cell Model Passports growth_rate_latest.csv |
| T790M | fitness_cost | 0 | fraction | not_applied | 0 | 0-0 | measured clone-specific growth_rate_per_day is used directly |
| T790M | max_drug_death_rate | 0.4621 | 1/day | inferred | 0 | 0.4621-0.4621 | derived from IC50 definition: GDSC2 fitted dose-response: IC50 is the concentration giving 50% relative viability after 72 h of exposure (Yang W et al. NAR 2013 (GDSC); Iorio F et al. Cell 2016; Vis DJ et al. Pharmacogenomics 2016 (IC50 fitting); GDSC_Fitted_Data_Description.pdf release 8.5) |
| T790M | hill_coefficient | 1.2 | dimensionless | assumed | 0 |  | curated simulator seed; GDSC sigmoid slopes are not exported per curve |
| T790M | gefitinib_ic50 | 1.364e+04 | nM | measured | 1 | 1.364e+04-1.364e+04 | normalized drug_response.csv |
| T790M | osimertinib_ic50 | 37.93 | nM | measured | 1 | 37.93-37.93 | normalized drug_response.csv |
| T790M | capmatinib_ic50 | 8000 | nM | assumed | 0 | 8000-8000 | curated simulator seed fallback |
| C797S | growth_rate | 0.4073 | 1/day | inferred | 1 | 0.4073-0.4073 | inherited from parent clone T790M (measured, n=1); the assumed fitness_cost is applied once by the simulator |
| C797S | fitness_cost | 0.18 | fraction | assumed | 1 | 0.18-0.18 | curated simulator seed |
| C797S | max_drug_death_rate | 0.4621 | 1/day | inferred | 0 | 0.4621-0.4621 | derived from IC50 definition: GDSC2 fitted dose-response: IC50 is the concentration giving 50% relative viability after 72 h of exposure (Yang W et al. NAR 2013 (GDSC); Iorio F et al. Cell 2016; Vis DJ et al. Pharmacogenomics 2016 (IC50 fitting); GDSC_Fitted_Data_Description.pdf release 8.5) |
| C797S | hill_coefficient | 1.2 | dimensionless | assumed | 0 |  | curated simulator seed; GDSC sigmoid slopes are not exported per curve |
| C797S | gefitinib_ic50 | 1.7e+04 | nM | assumed | 0 | 1.7e+04-1.7e+04 | curated simulator seed fallback |
| C797S | osimertinib_ic50 | 9200 | nM | assumed | 0 | 9200-9200 | curated simulator seed fallback |
| C797S | capmatinib_ic50 | 8000 | nM | assumed | 0 | 8000-8000 | curated simulator seed fallback |
| MET_AMP | growth_rate | 0.2742 | 1/day | inferred | 5 | 0.1733-0.3838 | inherited from parent clone EGFR (measured, n=5); the assumed fitness_cost is applied once by the simulator |
| MET_AMP | fitness_cost | 0.06 | fraction | assumed | 1 | 0.06-0.06 | curated simulator seed |
| MET_AMP | max_drug_death_rate | 0.4621 | 1/day | inferred | 0 | 0.4621-0.4621 | derived from IC50 definition: GDSC2 fitted dose-response: IC50 is the concentration giving 50% relative viability after 72 h of exposure (Yang W et al. NAR 2013 (GDSC); Iorio F et al. Cell 2016; Vis DJ et al. Pharmacogenomics 2016 (IC50 fitting); GDSC_Fitted_Data_Description.pdf release 8.5) |
| MET_AMP | hill_coefficient | 1.2 | dimensionless | assumed | 0 |  | curated simulator seed; GDSC sigmoid slopes are not exported per curve |
| MET_AMP | gefitinib_ic50 | 4500 | nM | assumed | 0 | 4500-4500 | curated simulator seed fallback |
| MET_AMP | osimertinib_ic50 | 2200 | nM | assumed | 0 | 2200-2200 | curated simulator seed fallback |
| MET_AMP | capmatinib_ic50 | 80 | nM | assumed | 0 | 80-80 | curated simulator seed fallback |
| mutation | p_mutation[EGFR->T790M] | 2e-05 | per division | assumed | 0 |  | curated resistance graph; not derived from cBioPortal prevalence |
| mutation | p_mutation_effective[EGFR->T790M] | 0.001 | per division | assumed | 0 |  | demo scaling x50 so that resistance can arise in a ~10^3-cell lattice |
| mutation | p_mutation[T790M->C797S] | 1e-05 | per division | assumed | 0 |  | curated resistance graph; not derived from cBioPortal prevalence |
| mutation | p_mutation_effective[T790M->C797S] | 0.0005 | per division | assumed | 0 |  | demo scaling x50 so that resistance can arise in a ~10^3-cell lattice |
| mutation | p_mutation[EGFR->MET_AMP] | 1e-05 | per division | assumed | 0 |  | curated resistance graph; not derived from cBioPortal prevalence |
| mutation | p_mutation_effective[EGFR->MET_AMP] | 0.0005 | per division | assumed | 0 |  | demo scaling x50 so that resistance can arise in a ~10^3-cell lattice |
| mutation | p_mutation[T790M->MET_AMP] | 1e-05 | per division | assumed | 0 |  | curated resistance graph; not derived from cBioPortal prevalence |
| mutation | p_mutation_effective[T790M->MET_AMP] | 0.0005 | per division | assumed | 0 |  | demo scaling x50 so that resistance can arise in a ~10^3-cell lattice |
| physics | lattice_spacing | 20 | um | literature_derived | 0 |  | typical epithelial tumour cell diameter 15-20 um (PhysiCell default volume 2494 um^3) |
| physics | drug_diffusion | 500 | um^2/s | literature_derived | 0 |  | small-molecule interstitial diffusivity order of magnitude (physics_calibration.json) |
| physics | drug_diffusion_lattice | 1.08e+05 | sites^2/day | inferred | 0 |  | D * 86400 / dx^2 |
| physics | drug_decay | 0.02 | 1/h | assumed | 0 |  | physics_calibration.json; gefitinib plasma t1/2 ~41 h would give 0.017/h |
| physics | drug_decay_length | 474.3 | sites | inferred | 0 |  | sqrt(D/k) |
| physics | drug_uptake_rate | 0.015 | 1/day per occupied site | assumed | 0 |  | simulator constant |
| physics | vessel_drug_concentration | 1000 | nM | assumed | 0 |  | constant plasma level; no pharmacokinetics (physics_calibration.json) |
| physics | oxygen_diffusion | 0.12 | lattice units | assumed | 0 |  | dimensionless; with uptake sets ~120-170 um penetration, consistent with Thomlinson & Gray 1955 |
| physics | oxygen_uptake_rate | 0.05 | lattice units | assumed | 0 |  | simulator constant (linear uptake) |
| physics | oxygen_mm_vmax | 0.04 | lattice units | assumed | 0 |  | Michaelis-Menten uptake |
| physics | oxygen_mm_km | 0.25 | normalised O2 | assumed | 0 |  | Michaelis-Menten half-saturation |
| physics | oxygen_vessel_source | 0.35 | lattice units | assumed | 0 |  | vessel sites saturate at 1.0 |
| physics | proliferation_oxygen_threshold | 0.22 | fraction of vessel O2 | assumed | 0 |  | PhysiCell: proliferation stops below 5 mmHg of a 38 mmHg vessel (0.13); here 0.22 |
| physics | necrosis_threshold | 0.06 | fraction of vessel O2 | assumed | 0 |  | PhysiCell necrosis onset 5 mmHg / 38 mmHg = 0.13; here 0.06 |
| physics | necrosis_exposure_time | 0.25 | days | assumed | 0 |  | sustained hypoxia before necrosis |
| physics | hypoxic_death_rate | 0.04 | 1/day | assumed | 0 |  | after exposure time is exceeded |
| physics | necrotic_clearance_rate | 0.25 | 1/day | assumed | 0 |  | dead-cell clearance; apoptotic clearance is hours, necrotic debris days-weeks |
| world | vessel_spacing | 150 | um | literature_derived | 0 |  | tumour intercapillary distance 100-200 um (Thomlinson & Gray 1955; Vaupel 1989) |
| physics | oxygen_solver_tolerance | 1e-07 | normalised O2 | numerical | 0 |  | max change per SOR sweep |
| physics | drug_solver_tolerance | 1e-09 | normalised C | numerical | 0 |  | max change per SOR sweep |

# Units

| quantity | unit | where |
| --- | --- | --- |
| lattice spacing dx | um | AutomataConfig.lattice_spacing_um, WorldConfig.cell_size_um |
| biological time step dt | days | SimulationRunner.run(dt=...), AutomataConfig.necrosis_exposure_time |
| experiment horizon | days | --days |
| growth rate | 1/day | ClonePhenotype.growth_rate; P_div = 1 - exp(-r (1-c) dt) |
| max drug death rate k_max | 1/day | ClonePhenotype.max_drug_death_rate; P_death = 1 - exp(-k_max E(C) dt) |
| hypoxic death rate | 1/day | AutomataConfig.hypoxic_death_rate |
| dead-cell clearance rate | 1/day | AutomataConfig.necrotic_clearance_rate |
| drug concentration | nM | IC50 (GDSC LN_IC50 in ln uM -> exp()*1000 nM); local C = normalised field x vessel nM |
| drug diffusivity | um^2/s -> sites^2/day | AutomataConfig.drug_diffusion_um2_s -> drug_grid_diffusion_per_day |
| drug decay | 1/h -> 1/day | AutomataConfig.drug_decay_per_hour -> drug_decay_per_day |
| oxygen | fraction of vessel value (0-1) | ScalarField; thresholds are fractions |
| oxygen diffusion / uptake | dimensionless lattice coefficients | only their ratio (penetration depth) is physical |
| mutation probability | per successful division | resistance_graph.json x mutation_probability_scale |
| legacy explicit drug solver | sites^2/day (0.1), 1/day decay | drug_solver=explicit_legacy only; dimensionally inconsistent with the physics file |
