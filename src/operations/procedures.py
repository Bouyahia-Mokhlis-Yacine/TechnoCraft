"""A small allowlisted procedure catalogue for lexical documentation retrieval."""

import re


PROCEDURES = (
    ('reference_review', r'\b(?:reference|prior|review|quarantaine|historique)\b',
     'reports/sequential_detection_results.md#incident-state-and-replay',
     'Review closed batches before admitting them to a reference. Keep candidate and incident dates pending until review.',
     'Examinez les lots clôturés avant de les intégrer à la référence. Les dates candidates ou en incident restent en attente de validation.'),
    ('collective_followup', r'\b(?:collectiv\w*|shared|commun\w*|channel|canal)\b',
     'reports/collective_detection_results.md#methods',
     'Check local merchant corroboration and independent service telemetry before escalating a shared operational symptom.',
     'Vérifiez les indices chez les commerçants et les données techniques indépendantes avant de transmettre un symptôme commun.'),
    ('recovery_followup', r'\b(?:recovery|recover\w*|retablissement|retour)\b',
     'src/detection/incidents.py',
     'Check for consecutive quiet closed days against the pinned baseline. Track recovery in the incident lifecycle.',
     'Vérifiez les jours clôturés consécutifs revenus à la normale par rapport à la référence figée. Suivez le rétablissement dans le cycle de l’incident.'),
)


def find_procedure(text, language):
    matches = [(key, source, fr if language == 'fr' else en)
               for key, pattern, source, en, fr in PROCEDURES if re.search(pattern, text)]
    if len(matches) != 1:
        return None
    key, source, excerpt = matches[0]
    return {'procedure_id': key, 'source': source, 'excerpt': excerpt}
