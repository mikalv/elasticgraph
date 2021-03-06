const Q = require('q')
const async = require('async-q')
const _ = require('lodash')
const deepMerge = require('deepmerge')
const debug = require('debug')('elasticgraph:deep/graph/unionCalculator')

const utils = require('../utils')
const traverser = require('./traverser')

module.exports.recalculateUnionInSibling = (sourceEntityOld, sourceEntityNew, updatedField, toUpdateDestEntity, destEntityField, cache) => {
  /**if (!cache.es.config.schema[sourceEntityNew._type][updatedField].isRelationship) {
    return Q()
  }**/

  const newFieldValue = _.get(sourceEntityNew._source || sourceEntityNew.fields, updatedField)
  const oldFieldValue = sourceEntityOld && _.get(sourceEntityOld._source || sourceEntityOld.fields, updatedField)

  if (_.isEmpty(newFieldValue) && _.isEmpty(oldFieldValue)) {
    return Q()
  }

  //debug('recalculateUnionInSibling', sourceEntityNew._type, sourceEntityNew._id, 'updated field ', updatedField, 'new value', newFieldValue, 'old value', oldFieldValue, 'to update entity', JSON.stringify(toUpdateDestEntity), "to update field", destEntityField)

  const toUpdateDestEntityBody = toUpdateDestEntity._source || toUpdateDestEntity.fields

  const sourceEntitySchema = cache.es.config.schema[sourceEntityNew._type]
  const updatedFieldSchema = sourceEntitySchema[updatedField]

  //debug('recalculateUnionInSibling', sourceEntityNew._type, sourceEntityNew._id, 'updated field ', updatedField, 'new value', newFieldValue, 'old value', oldFieldValue, 'to update entity', JSON.stringify(toUpdateDestEntity), "to update field", destEntityField)
  
  if (!_.isArray(updatedFieldSchema.type)) {//if updatedField is single value field, simply copy new updatedField value into destEntityField value. This is a hack till we have a copyTo

    //TODO make a copy functionality and move single value field updates to copyTo
    
    const newDestEntityFieldValue = (sourceEntityNew._source || sourceEntityNew.fields)[updatedField]
    return cache.es.deep.update(
      {
        _id: toUpdateDestEntity._id,
        _type: toUpdateDestEntity._type,
        update: {set: {[destEntityField]: newDestEntityFieldValue}}
      },
      cache
    )
    .then((res) => {
      cache.markDirtyEntity(toUpdateDestEntity)
      return res
    })
  }

  //ELSE if updatedField is an array. (The intended application of union functionality is for array fields only)
  //Create meta object if needed
  toUpdateDestEntityBody.meta = toUpdateDestEntityBody.meta || {}
  //Create meta object for field if needed
  toUpdateDestEntityBody.meta[destEntityField] = toUpdateDestEntityBody.meta[destEntityField] || {}

  //Update toUpdateDestEntity.meta object, based on the new values as compared to the old values of udpatedField in sourceEntity
  handleIncrements(cache, sourceEntityOld, sourceEntityNew, updatedField, toUpdateDestEntity, destEntityField)
  handleDecrements(cache, sourceEntityOld, sourceEntityNew, updatedField, toUpdateDestEntity, destEntityField)
  //Updated toUpdateDestEntity[destEntityField] 
  return updateUnionsInDestEntity(cache, toUpdateDestEntity, destEntityField)
}

const handleIncrements = (cache, sourceEntityOld, sourceEntityNew, updatedField, toUpdateDestEntity, destEntityField) => {

  const updatedFieldSchema = cache.es.config.schema[sourceEntityNew._type][updatedField]

  let increments

  if (updatedFieldSchema.isRelationship) {

    increments = differenceForRelation(sourceEntityNew, sourceEntityOld, updatedField, cache)
  } else {

    increments = differenceForField(sourceEntityNew, sourceEntityOld, updatedField)
  }

  const toUpdateDestEntityBody = toUpdateDestEntity._source || toUpdateDestEntity.fields

  for (let value of increments) {//Update related entity accordingly
    toUpdateDestEntityBody.meta[destEntityField][value] = toUpdateDestEntityBody.meta[destEntityField][value] || 0
    toUpdateDestEntityBody.meta[destEntityField][value] += 1
  }

  return increments
}

const differenceForRelation = (e1, e2, relation, cache) => {
  if (!e1) {
    return []
  }

  const e1Ids = _([_.get(e1._source || e1.fields, relation)])
    .flatten()
    .compact()
    .map('_id')
    .value()

  let difference = e1Ids
  let e2Ids

  if (e2) {
    e2Ids = _([_.get(e2._source || e2.fields, relation)])
      .flatten()
      .compact()
      .map('_id')
      .value()

    difference = _.difference(e1Ids, e2Ids)
  }

  //debug('Difference in relation e1:', e1._type, 'for relation', relation, 'e1 relations', e1Ids, 'e2:', e2 && e2._type, e2Ids, 'e1 In Cache', _.get(cache.get(e1._id + e1._type), '_source'))

  return difference

}

const differenceForField = (e1, e2, field) => {
  if (!e1) {
    return []
  }

  const e1Values = _([_.get(e1._source || e1.fields, field)])
    .flatten()
    .compact()
    .value()

  let difference = e1Values

  if (e2) {
    const e2Values = _([_.get(e2._source || e2.fields, field)])
      .flatten()
      .compact()
      .value()

    difference = _.difference(e1Values, e2Values)
  }

  return difference

}

const handleDecrements = (cache, sourceEntityOld, sourceEntityNew, updatedField, toUpdateDestEntity, destEntityField) => {

  let decrements

  if (cache.es.config.schema[sourceEntityNew._type][updatedField].isRelationship) {
    decrements = differenceForRelation(sourceEntityOld, sourceEntityNew, updatedField, cache)
  } else {

    decrements = differenceForField(sourceEntityOld, sourceEntityNew, updatedField)
  }
  //Decrement counts in meta for the removed values from the sourceEntityOld
  //debug(sourceEntityNew._type, 'found decrements', decrements, sourceEntityNew, "sourceEntityOld", sourceEntityOld)

  const toUpdateDestEntityBody = toUpdateDestEntity._source || toUpdateDestEntity.fields

  decrements.forEach((id) => {//Update related entity accordingly
    const referenceCounts = toUpdateDestEntityBody.meta[destEntityField]
    //Reduce count by 1, and if it has become zero remove this key
    if (!--referenceCounts[id]) {
      delete referenceCounts[id]
      if (_.isEmpty(referenceCounts)) { //If no more references are left, delete the empty object too
        delete toUpdateDestEntityBody.meta[destEntityField]
      }
    }
  })

  return decrements
}

const updateUnionsInDestEntity = (cache, toUpdateDestEntity, destEntityField) => {

  const toUpdateDestEntityBody = toUpdateDestEntity._source || toUpdateDestEntity.fields
  const existingValues = _([toUpdateDestEntityBody[destEntityField]]).flatten().compact().value()
	const destEntityFieldSchema = cache.es.config.schema[toUpdateDestEntity._type][destEntityField]
  const isRelation = destEntityFieldSchema.isRelationship

  //Now calculate new field value in toUpdateDestEntity through union of the reference counts and ownership
  const valuesWithPositiveCounts = _.transform(toUpdateDestEntityBody.meta[destEntityField], (result, count, value) => {

    if (!_.isUndefined(count) && count > 0) {
      //Push joined object if it exists, or push just the _id, to be later joined
      if (isRelation) {
        result.push(_.find(existingValues, {_id: value}) || {_id: value})
      } else if (value) {
        result.push(value)
      }
    }
  }, [])

  //debug('existing values', existingValues.map((v) => v._id))
  //debug(' values with positive meta counts', valuesWithPositiveCounts.map((v) => v._id))
  let newFieldValue = 
    _(isRelation && _.filter(existingValues, {own: true}) || undefined)
    .union(valuesWithPositiveCounts)
		.compact()
    .value()
  //debug('new field value', newFieldValue.map((v) => v._id))

  if (_.isEmpty(newFieldValue) && _.isEmpty(existingValues)) {
    return Q()
  }

  //For new links, resolveJoins and push
  //For removed links, call pull
  let updateInstruction
  if (_.isEmpty(newFieldValue)) {
    updateInstruction = {unset: {_path: destEntityField}}
  } else {
    updateInstruction = {set: {[destEntityField]: newFieldValue}} 
  }
  //debug('about to deep update unionIn', JSON.stringify(toUpdateDestEntity), 'new field value', JSON.stringify(newFieldValue), ' for field', destEntityField, 'updateInstruction', updateInstruction)
  //Update the related entity and its tree with the new field value
  return cache.es.deep.update(
    {
      _id: toUpdateDestEntity._id,
      _type: toUpdateDestEntity._type,
      update: updateInstruction 
    },
    cache
  )
  .then((res) => {
    cache.markDirtyEntity(toUpdateDestEntity)

    const cachedDestEntity = cache.get(toUpdateDestEntity._id + toUpdateDestEntity._type)
    const cachedDestEntityBody = cachedDestEntity._source || cachedDestEntity.fields
    cachedDestEntityBody.meta = deepMerge(cachedDestEntityBody.meta || {}, toUpdateDestEntityBody.meta)
    return res
  })
}

/**
 * The sourceEntityOld has been updated to sourceEntityNew by applying an update on a field. Update the nodes connected to sourceEntity and having fields which unionFrom this particular field of sourceEntity. 
 * @param {Object} cache
 * @param {Object} sourceEntityOld
 * @param {Object} sourceEntityNew
 * @param {String} updatedField
 */
module.exports.recalculateUnionInDependentGraph = (cache, sourceEntityOld, sourceEntityNew, updatedField) => {
  const entitySchema = cache.es.config.schema[sourceEntityNew._type]
  const updatedFieldSchema = entitySchema[updatedField]
  const path = 'startingFromMe.index.' + sourceEntityNew._type + '.' + updatedField + '.' + 'paths'
  const unionInPaths = _.get(updatedFieldSchema['unionIn'], path) || []

  return async.each(unionInPaths, (unionInPath) => {
    return utils.getEntitiesAtRelationPath(cache, sourceEntityNew, _.dropRight(unionInPath, 1))
    .then((toUpdateDestEntities) => {
      if (!toUpdateDestEntities.entities) {
        return
      }
      if (_.isArray(toUpdateDestEntities.entities)) {
        if (!_.size(_.compact(toUpdateDestEntities.entities))) {
          return
        }
      } else { //Make it an array
        toUpdateDestEntities.entities = [toUpdateDestEntities.entities]
      }

      //debug('recalculateUnionInGraph: will update union at path', unionInPath, 'sourceEntityNew', sourceEntityNew._source, 'sourceEntityOld._source', sourceEntityOld, 'to update entities', JSON.stringify(toUpdateDestEntities))
      
      return async.each(toUpdateDestEntities.entities, (toUpdateDestEntity) => {
        const destFieldToUpdate = _.last(unionInPath)
        return module.exports.recalculateUnionInSibling(sourceEntityOld, sourceEntityNew, updatedField, toUpdateDestEntity, destFieldToUpdate, cache)
      })
    })
  })
}

