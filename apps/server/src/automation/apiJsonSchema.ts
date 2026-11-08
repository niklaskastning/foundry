import * as Schema from "effect/Schema";
import * as SchemaAST from "effect/SchemaAST";
import * as SchemaRepresentation from "effect/SchemaRepresentation";

// JSON cannot carry undefined; the canonical JSON codec would incorrectly advertise it as null.
const jsonRepresentation = (
  ast: SchemaRepresentation.Representation,
): SchemaRepresentation.Representation => {
  switch (ast._tag) {
    case "Undefined":
      return { ...ast, _tag: "Never" };
    case "Arrays":
      return {
        ...ast,
        elements: ast.elements.map((element) => ({
          ...element,
          type: jsonRepresentation(element.type),
        })),
        rest: ast.rest.map(jsonRepresentation),
      };
    case "Objects":
      return {
        ...ast,
        propertySignatures: ast.propertySignatures.map((property) => ({
          ...property,
          type: jsonRepresentation(property.type),
        })),
        indexSignatures: ast.indexSignatures.map((index) => ({
          parameter: jsonRepresentation(index.parameter),
          type: jsonRepresentation(index.type),
        })),
      };
    case "Union":
      return { ...ast, types: ast.types.map(jsonRepresentation) };
    case "Suspend":
      return { ...ast, thunk: jsonRepresentation(ast.thunk) };
    case "Declaration":
      return { ...ast, typeParameters: ast.typeParameters.map(jsonRepresentation) };
    default:
      return ast;
  }
};
export const jsonSchema = (schema: Schema.Constraint) => {
  const representation = SchemaRepresentation.toRepresentation(SchemaAST.toEncoded(schema.ast));
  const document = SchemaRepresentation.toJsonSchemaDocument(
    {
      representation: jsonRepresentation(representation.representation),
      references: Object.fromEntries(
        Object.entries(representation.references).map(([key, value]) => [
          key,
          jsonRepresentation(value),
        ]),
      ),
    },
    { onExcessProperty: "error" },
  );
  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    ...document.schema,
    $defs: document.definitions,
  };
};
