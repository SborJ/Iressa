# Raw Data Inputs

Place public exports here before running:

```bash
python3 scripts/prepare_data.py
```

To create versioned source folders and a raw acquisition manifest:

```bash
python3 scripts/fetch_raw_data.py
```

By default this prints a plan and writes `data/raw/raw_acquisition_manifest.json`.
If you fill in URLs in `data/config/raw_sources.json`, you can run:

```bash
python3 scripts/fetch_raw_data.py --allow-network
```

The calibration pipeline expects these optional files:

## `gdsc_drug_response.csv`

Used for measured drug response.

Recognized columns include:

```text
model_id | cell_line_id | cosmic_id | sample_id | cell_line_name
model_name | cell_line_name | cell_line | sample_name
cancer_type | tcga_classification | disease
tissue | tissue_type | tissue_descriptor
drug | drug_name | compound | compound_name
ic50_nm | ln_ic50 | ic50 | auc
```

Preferred metric:

```text
IC50 in nM
```

## `cell_model_passports_mutations.csv`

Used for cell-line genotype and copy-number state.

Recognized columns include:

```text
model_id | cell_line_id | model_name | sample_id | cell_line_name
gene | hugo_symbol | symbol
alteration | mutation | variant | protein_change | cna
protein_change | aa_change | hgvsp
alteration_type | variant_type | type
cancer_type | disease | tcga_classification
tissue | tissue_type
```

## `civic_evidence.csv`

Used for literature evidence, not measured IC50.

Recognized columns include:

```text
civic_id | evidence_id | id
molecular_profile | variant | alteration | name
disease | cancer_type | phenotype
drug | therapy | therapies
response | clinical_significance | evidence_type
evidence_level | level
evidence_direction | direction
source_publication | citation | pubmed_id
```

## `cbioportal_alterations.csv`

Used for patient/sample alteration context, not per-division mutation rates.

Recognized columns include:

```text
sample_id | patient_id | model_id
gene | hugo_symbol | hugo_gene_symbol
alteration | protein_change | mutation | cna | copy_number
alteration_type | type | event_type
cancer_type | study_id | disease
tissue | sample_type
```

## Important

cBioPortal prevalence should not be converted into mutation probability per
division. Mutation probabilities remain simulation assumptions unless a specific
experimental/modeling source supports them.
